// push_schedules_to_redis.mjs
// One-off script: writes the manually-scraped GX schedules into Redis,
// bypassing the Apify scrape path so the app serves real data immediately.
//
// Run from the project root:  node push_schedules_to_redis.mjs
// (reads UPSTASH_* from .env automatically via --env-file if Node ≥ 20.6,
//  otherwise dotenv is loaded below as a fallback)

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load .env (Node < 20.6 fallback) ─────────────────────────────────────────
const envPath = join(__dirname, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.error("Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN in .env");
  process.exit(1);
}

// ── Week label (mirrors instagram.ts weekAnchor) ──────────────────────────────
const MYT_OFFSET = 8 * 60 * 60 * 1000;
const WEEK_BOUNDARY_SHIFT = 2 * 60 * 60 * 1000;

function weekAnchor(now = Date.now()) {
  const myt = new Date(now + MYT_OFFSET + WEEK_BOUNDARY_SHIFT);
  const sinceMon = (myt.getUTCDay() + 6) % 7;
  const mondayAsUtc = Date.UTC(myt.getUTCFullYear(), myt.getUTCMonth(), myt.getUTCDate() - sinceMon);
  const label = new Date(mondayAsUtc).toISOString().slice(0, 10);
  const nextRollover = mondayAsUtc - MYT_OFFSET - WEEK_BOUNDARY_SHIFT + 7 * 24 * 60 * 60 * 1000;
  return { label, expiresInSecs: Math.max(1, Math.ceil((nextRollover - now) / 1000)) };
}

const { label, expiresInSecs } = weekAnchor();
console.log(`Week label: ${label}  (TTL: ${Math.round(expiresInSecs / 3600)}h)`);

// ── Day / time conversion ─────────────────────────────────────────────────────
const DAY_MAP = { MON:"Mon", TUE:"Tue", WED:"Wed", THU:"Thu", FRI:"Fri", SAT:"Sat", SUN:"Sun" };

function to24h(t) {
  const m = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1]);
  const period = m[3].toUpperCase();
  if (period === "AM") { if (h === 12) h = 0; }
  else                 { if (h !== 12) h += 12; }
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

// ── Load scraped data ─────────────────────────────────────────────────────────
// Looks for the JSON next to this script; fall back to the outputs folder.
const candidates = [
  join(__dirname, "af_gx_schedules.json"),
  join(__dirname, "..", "Library/Application Support/Claude/local-agent-mode-sessions/df2133b6-b884-4f14-8ed1-0f427ddeed23/151ab429-8805-4f2f-b7ac-622af434bc17/local_b4f1a358-5932-4db7-a4f7-6e7e443be00e/outputs/af_gx_schedules.json"),
];
const jsonPath = candidates.find(existsSync);
if (!jsonPath) {
  console.error("af_gx_schedules.json not found. Copy it next to this script.");
  process.exit(1);
}
console.log(`Loading: ${jsonPath}`);
const raw = JSON.parse(readFileSync(jsonPath, "utf8"));

// ── Build Timetable entries ───────────────────────────────────────────────────
const ERROR_TTL = 6 * 60 * 60;

const entries = raw.gyms.map((gym) => {
  const handle = gym.handle;
  if (!gym.classes?.length) {
    return { handle, images: [], caption: "", postUrl: null, takenAt: null,
             matchedMonth: false, error: gym.note ?? "no schedule found", _ttl: ERROR_TTL };
  }
  const schedule = [];
  for (const c of gym.classes) {
    const day = DAY_MAP[c.day?.toUpperCase()];
    const startTime = to24h(c.time);
    const className = c.class?.trim();
    if (!day || !startTime || !className) {
      process.env.DEBUG && console.warn(`  skip: ${handle} day="${c.day}" time="${c.time}" class="${c.class}"`);
      continue;
    }
    const s = { day, startTime, className };
    if (c.instructor?.trim()) s.instructor = c.instructor.trim();
    schedule.push(s);
  }
  const postUrl = gym.post ? `https://www.instagram.com/p/${gym.post}/` : null;
  return { handle, images: [], caption: gym.period ?? gym.scheduleType ?? "",
           postUrl, takenAt: null, matchedMonth: true, schedule, _ttl: expiresInSecs };
});

console.log(`Prepared: ${entries.length} entries, ${entries.filter(e => e.schedule?.length).length} with schedules`);

// ── Write to Redis via Upstash pipeline ───────────────────────────────────────
const BATCH = 10;
let ok = 0, failed = 0;

for (let i = 0; i < entries.length; i += BATCH) {
  const batch = entries.slice(i, i + BATCH);
  const commands = batch.map(({ handle, _ttl, ...timetable }) => [
    "SET", `af-cal:tt:${label}:${handle}`, JSON.stringify(timetable), "EX", String(_ttl),
  ]);

  let results;
  try {
    const res = await fetch(`${UPSTASH_URL}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    results = await res.json();
  } catch (e) {
    console.error(`Batch ${i}–${i + batch.length - 1} network error: ${e.message}`);
    for (const { handle } of batch) { console.error(`  ✗ ${handle}`); failed++; }
    continue;
  }

  for (let j = 0; j < batch.length; j++) {
    const { handle, schedule } = batch[j];
    const r = results[j];
    if (r?.error || r?.result === null) {
      console.error(`  ✗ ${handle}: ${r?.error ?? "null result"}`);
      failed++;
    } else {
      console.log(`  ✓ ${handle} (${schedule?.length ?? 0} classes)`);
      ok++;
    }
  }
}

console.log(`\n${"─".repeat(40)}`);
console.log(`Written: ${ok}  Failed: ${failed}`);
