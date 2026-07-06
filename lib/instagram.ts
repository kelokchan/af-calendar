// Instagram fetch via Apify (apify/instagram-scraper) — paid per result, but
// results live in Redis cached for the whole week, so a profile is only scraped
// once per week (gyms post a fresh weekly timetable each Sunday night). Cards
// fetch on demand (one profile per request); each Sunday-night rollover → keys
// expire → re-scraped as viewed. A force-refresh re-scrapes a profile on demand.

import { Redis } from "@upstash/redis";
import { put } from "@vercel/blob";
import { generateText, Output } from "ai";
import { z } from "zod";

// One parsed class slot from a timetable image. day/startTime are normalized so
// the cross-gym filter can compare them; instructor is display-only and optional.
export type ClassSession = {
  day: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
  startTime: string; // 24-hour, zero-padded "HH:MM"
  className: string;
  instructor?: string;
};

export type Timetable = {
  handle: string;
  images: string[]; // all images of the chosen post (carousel = multiple)
  caption: string;
  postUrl: string | null;
  takenAt: number | null;
  matchedMonth: boolean; // caption mentions current month / timetable keyword
  schedule?: ClassSession[]; // vision-extracted classes; absent if none parsed
  error?: string;
};

// IG returns region-local image hosts (`*.fna.fbcdn.net`, `scontent-<pop>`) that
// aren't reachable from servers. The URL signature is path-bound, not host-bound,
// so rewriting to the global CDN host makes the same image fetchable everywhere.
export const cdnUrl = (u: string) =>
  u.replace(/^https:\/\/[^/]+/, "https://scontent.cdninstagram.com");

// "HH:MM" (24h) → "h:MMam/pm". Minutes always shown ("7:00am").
export const to12h = (t: string) => {
  const h = +t.slice(0, 2);
  const m = t.slice(3, 5);
  return `${((h + 11) % 12) + 1}:${m}${h < 12 ? "am" : "pm"}`;
};

// OCR yields ALL-CAPS class/instructor text. Title-case for display.
export const titleCase = (s: string) =>
  s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// Normalized post, source-agnostic. Exported so the local Playwright sync script
// (scripts/sync.ts) can feed posts into the same pick/classify/extract pipeline
// the Apify path uses — see syncTimetableFromPosts.
export type Post = {
  caption: string;
  images: string[];
  url: string | null;
  takenAt: number | null;
  pinned: boolean;
};

// A real schedule post says "timetable", OR "schedule" alongside a class
// context (gx / group / class / exercise / workout). Bare "schedule" (e.g.
// "no perfect schedule") and bare month names ("June babies", "action-packed
// June") are NOT enough — they matched random promos/birthdays before.
function looksLikeTimetable(caption: string): boolean {
  const c = caption.toLowerCase();
  if (/timetable/.test(c)) return true;
  return /schedule/.test(c) && /\b(gx|group|class|exercise|workout)\b/.test(c);
}

// Stronger caption signal used to PICK the schedule post from the caption alone,
// so we can skip the multi-image vision classifier and OCR only the chosen post.
// Covers the keyword heuristic plus the date captions gyms actually use:
//   • weekly range — "29 Jun - 5 Jul", "15-30 June", "29/6 - 5/7"
//   • a bare month / Month-Year as the WHOLE caption — "June", "June 2026"
// extractSchedule still verifies the pick, so a false positive just yields zero
// sessions and falls through to the classifier — no wrong data gets cached.
const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
export function captionLikelyTimetable(caption: string): boolean {
  const c = caption.toLowerCase();
  if (looksLikeTimetable(c)) return true;
  if (
    new RegExp(
      `\\b\\d{1,2}\\s*(${MONTHS})?[a-z]*\\s*(?:[-–—]|to)\\s*\\d{1,2}\\s*(${MONTHS})`,
    ).test(c)
  )
    return true; // "29 Jun - 5 Jul"
  if (/\b\d{1,2}\/\d{1,2}\s*[-–—]\s*\d{1,2}\/\d{1,2}/.test(c)) return true; // "29/6 - 5/7"
  if (new RegExp(`^\\s*(${MONTHS})[a-z]*\\.?\\s*\\d{0,4}\\s*$`).test(c))
    return true; // caption is just "June" / "June 2026"
  return false;
}

// Gyms pin the current schedule, so prefer pinned. Priority:
//   1. pinned + timetable caption (the schedule, even if newer posts mention
//      classes — e.g. a "no class this week" notice that also keyword-matches)
//   2. any timetable caption (most recent)
//   3. pinned (schedule whose caption skipped the keywords)
//   4. most recent post
function choose(handle: string, posts: Post[]): Timetable {
  const base: Timetable = {
    handle,
    images: [],
    caption: "",
    postUrl: null,
    takenAt: null,
    matchedMonth: false,
  };
  if (!posts.length) return { ...base, error: "no posts" };
  const match =
    posts.find((p) => p.pinned && looksLikeTimetable(p.caption)) ??
    posts.find((p) => looksLikeTimetable(p.caption)) ??
    posts.find((p) => p.pinned) ??
    posts[0];
  return {
    handle,
    images: match.images,
    caption: match.caption,
    postUrl: match.url,
    takenAt: match.takenAt,
    // Caption-less schedules are common; a pinned post is the gym's current
    // timetable by convention, so trust the pin even without keyword match.
    matchedMonth: looksLikeTimetable(match.caption) || match.pinned,
  };
}

// ---- Apify scrape -----------------------------------------------------------

type ApifyItem = {
  ownerUsername?: string;
  caption?: string;
  url?: string;
  displayUrl?: string;
  images?: string[];
  childPosts?: {
    displayUrl?: string;
  }[];
  timestamp?: string;
  type?: string;
  isPinned?: boolean;
};

// apify/instagram-profile-scraper returns one item per username: the profile,
// with its recent posts inlined as `latestPosts`. `error` is set (e.g.
// "no_items" / "Empty or private data") when IG blocked/walled the scrape.
type ProfileItem = {
  username?: string;
  private?: boolean;
  latestPosts?: ApifyItem[];
  error?: string;
};

function toPost(it: ApifyItem): Post {
  const images = it.childPosts?.length
    ? (it.childPosts.map((c) => c.displayUrl).filter(Boolean) as string[])
    : it.images?.length
      ? it.images
      : it.displayUrl
        ? [it.displayUrl]
        : [];
  return {
    caption: it.caption ?? "",
    images: images.map(cdnUrl),
    url: it.url ?? null,
    takenAt: it.timestamp ? Math.floor(Date.parse(it.timestamp) / 1000) : null,
    pinned: !!it.isPinned,
  };
}

// opts (force restart): postUrl narrows the scrape to that exact post (takes
// precedence); limit overrides how many recent posts we keep.
type ScrapeOpts = { postUrl?: string; limit?: number };

// One profile → its recent posts, newest first.
//
// Uses apify/instagram-profile-scraper, NOT apify/instagram-scraper: the latter
// fetches each post's detail page, a step IG now hard-blocks logged-out (every
// run came back as "no_items" stubs — the "Apify blocked" symptom). The profile
// scraper reads IG's web-profile endpoint in one request and inlines the recent
// posts as `latestPosts`, which still gets through.
async function scrapePosts(
  handle: string,
  opts: ScrapeOpts = {},
): Promise<Post[]> {
  const token = process.env.APIFY_TOKEN!;
  const res = await fetch(
    `https://api.apify.com/v2/acts/apify~instagram-profile-scraper/run-sync-get-dataset-items?token=${token}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usernames: [handle] }),
      // ponytail: cap the sync scrape so a stuck Apify run can't hang the request
      // forever. Called per-profile, so this is one profile's budget.
      signal: AbortSignal.timeout(120_000),
    },
  );
  if (!res.ok) throw new Error(`Apify HTTP ${res.status}`);
  const items: ProfileItem[] = await res.json();
  const profile = items[0];
  // No profile, an error flag, or zero inlined posts = IG walled/blocked this
  // scrape (or a private/renamed handle). Throw so the caller serves last week's
  // timetable on a short TTL and re-scrapes soon, instead of caching an empty pick.
  let posts = profile?.latestPosts ?? [];
  if (!profile || profile.error || !posts.length)
    throw new Error(
      `Apify blocked (${profile?.error ?? "no posts"}) for ${handle}`,
    );
  // ponytail: profile-scraper can't target a single post URL, so a pasted link
  // filters the profile's recent posts to that one (works for posts in the latest
  // window — the common case). Falls back to all if the link is older/not found.
  if (opts.postUrl) {
    const hit = posts.filter((p) => p.url && opts.postUrl!.startsWith(p.url));
    if (hit.length) posts = hit;
  } else if (opts.limit != null) {
    posts = posts.slice(0, opts.limit);
  }
  return posts.map(toPost);
}

// ---- Vision: identify the timetable post + extract its schedule -------------
// The dominant miss is an image-only, plain-caption, unpinned timetable that a
// newer promo outranks — invisible to caption/pin heuristics, legible only in
// the image. A cheap vision model looks at the top candidates, says which one
// (if any) IS the weekly class timetable, and extracts its sessions in the same
// call (powering the list view + cross-gym filter). Cache-miss path only, so
// it runs ~once per gym per week.

const N_CANDIDATES = 10; // cover images shown to the classifier; some gyms (e.g. SS2) bury the timetable under promos + pinned posts, so look deeper

// 2.5-flash misread dense grids: on SS15 it drifted Saturday's 11:30 Hatha Yoga
// into the empty 20:00 cell ~1 in 4 runs (time printed above icon, instructor
// below, short day-columns leaving blanks below). 3.1-flash-lite reads the same
// grid correctly 5/5 — matching gold gemini-3-pro — while staying flash-tier
// cheap. The classify step + the schedule.length guard still gate out the
// meme/promo fabrication that older lite models produced.
const VISION_MODEL = "google/gemini-3.1-flash-lite";

// Step 1 — classify: which candidate cover image is the weekly timetable? -1 = none.
const ClassifyResult = z.object({ timetableIndex: z.number().int() });

// Step 2 — extract: read sessions from the chosen post's image(s). day is a free
// string (NOT z.enum) — the model transcribes the image's own labels ("THURSDAY",
// "FIRDAY"), which an enum would reject, discarding the whole timetable. Normalized
// to DAYS in normalizeSessions below.
const ExtractResult = z.object({
  sessions: z.array(
    z.object({
      day: z.string(),
      startTime: z.string(),
      className: z.string(),
      instructor: z.string().optional(),
    }),
  ),
});

// Map a raw model day label → canonical Mon–Sun, tolerant of case, full names,
// and the typos gyms actually print. null → drop that row (not the whole table).
const DAY_ALIASES: Record<string, ClassSession["day"]> = {
  mon: "Mon",
  monday: "Mon",
  tue: "Tue",
  tues: "Tue",
  tuesday: "Tue",
  wed: "Wed",
  weds: "Wed",
  wednesday: "Wed",
  thu: "Thu",
  thur: "Thu",
  thurs: "Thu",
  thursday: "Thu",
  fri: "Fri",
  friday: "Fri",
  firday: "Fri",
  frday: "Fri",
  sat: "Sat",
  saturday: "Sat",
  sun: "Sun",
  sunday: "Sun",
};
function normalizeDay(raw: string): ClassSession["day"] | null {
  const k = raw.toLowerCase().replace(/[^a-z]/g, "");
  return DAY_ALIASES[k] ?? DAY_ALIASES[k.slice(0, 3)] ?? null;
}

// Normalize + validate the model's rows: canonical day, "HH:MM" time, non-empty
// class. Drops only the rows that fail, keeping the rest of the timetable.
function normalizeSessions(
  raw: {
    day: string;
    startTime: string;
    className: string;
    instructor?: string;
  }[],
): ClassSession[] {
  const out: ClassSession[] = [];
  for (const s of raw) {
    const day = normalizeDay(s.day ?? "");
    const startTime = (s.startTime ?? "").trim();
    const className = (s.className ?? "").trim();
    if (!day || !/^\d{1,2}:\d{2}$/.test(startTime) || !className) continue;
    // zero-pad "7:30" → "07:30" so string compare in the time filter is correct.
    out.push({
      day,
      startTime: startTime.padStart(5, "0"),
      className,
      instructor: s.instructor?.trim() || undefined,
    });
  }
  return out;
}

// On Vercel the gateway authenticates via OIDC; locally it needs a key. Both
// absent → skip vision (fast, no failing call) and fall back to the heuristic.
const visionEnabled = !!(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL);

const CLASSIFY_PROMPT =
  "These are recent Instagram posts from an Anytime Fitness gym, labeled Image 0, Image 1, and so on. " +
  "At most one is the gym's WEEKLY GROUP-CLASS TIMETABLE: a grid or list of class names with days and times. " +
  "Promos, memes, events, holidays, birthdays, member spotlights and equipment posts are NOT timetables. " +
  "Return timetableIndex = the label number of the timetable image, or -1 if none qualifies.";

const EXTRACT_PROMPT =
  "The following image(s) are one gym's weekly class timetable (it may span multiple carousel pages). " +
  "Extract EVERY class session you can read: day (Mon–Sun), startTime as zero-padded 24-hour HH:MM " +
  "(e.g. 07:00, 19:30), className, and instructor if shown. List a class under each day it runs. " +
  "Do not invent rows. If an image is NOT actually a class timetable, return no sessions.";

// Fetch image bytes ourselves (IG blocks server hotlinks without these headers)
// and hand the model a self-describing data URL.
async function fetchImageData(u: string): Promise<string | null> {
  try {
    const res = await fetch(u, {
      headers: {
        "user-agent": "Mozilla/5.0",
        referer: "https://www.instagram.com/",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "image/jpeg";
    const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
    return `data:${ct};base64,${b64}`;
  } catch {
    return null;
  }
}

type Part = { type: "text"; text: string } | { type: "image"; image: string };

// Step 1: which candidate post is the timetable? Returns an index into `posts`,
// or -1 (no timetable / vision disabled / failure) so the caption-pin heuristic
// stands. Cheap — one cover image per candidate.
async function classifyTimetable(posts: Post[]): Promise<number> {
  if (!visionEnabled) {
    console.warn(
      "[vision] disabled — no AI_GATEWAY_API_KEY (and not on Vercel); using heuristic",
    );
    return -1;
  }
  const candidates = posts.slice(0, N_CANDIDATES);
  const datas = await Promise.all(
    candidates.map((p) => (p.images[0] ? fetchImageData(p.images[0]) : null)),
  );
  const content: Part[] = [{ type: "text", text: CLASSIFY_PROMPT }];
  // Keep labels = candidate index even when one fails to fetch, so the model's
  // timetableIndex maps straight back to posts[index].
  datas.forEach((d, i) => {
    if (d) {
      content.push({ type: "text", text: `Image ${i}:` });
      content.push({ type: "image", image: d });
    }
  });
  if (content.length === 1) {
    console.warn("[vision] no candidate images fetchable — using heuristic");
    return -1;
  }
  try {
    const { output } = await generateText({
      model: VISION_MODEL,
      output: Output.object({ schema: ClassifyResult }),
      messages: [{ role: "user", content }],
    });
    console.log(`[vision] classify → index ${output.timetableIndex}`);
    return output.timetableIndex;
  } catch (e) {
    console.error(
      "[vision] classify failed:",
      e instanceof Error ? e.message : e,
    );
    return -1;
  }
}

// Step 2: read all sessions from a timetable post's image(s) — sends every
// carousel page, so a grid split across pages is fully captured. Extracting on
// just the chosen image (vs one combined call over five candidates) is markedly
// more complete. Empty on disabled / unfetchable / failure / not-a-timetable.
export async function extractSchedule(
  images: string[],
): Promise<ClassSession[]> {
  if (!visionEnabled || !images.length) return [];
  const datas = (
    await Promise.all(images.slice(0, 4).map((u) => fetchImageData(u)))
  ).filter((d): d is string => !!d);
  if (!datas.length) return [];
  const content: Part[] = [
    { type: "text", text: EXTRACT_PROMPT },
    ...datas.map((d): Part => ({ type: "image", image: d })),
  ];
  try {
    const { output } = await generateText({
      model: VISION_MODEL,
      output: Output.object({ schema: ExtractResult }),
      messages: [{ role: "user", content }],
    });
    const sessions = normalizeSessions(output.sessions);
    console.log(
      `[vision] extract → ${output.sessions.length} raw → ${sessions.length} sessions`,
    );
    return sessions;
  } catch (e) {
    console.error(
      "[vision] extract failed:",
      e instanceof Error ? e.message : e,
    );
    return [];
  }
}

// ---- Redis cache ------------------------------------------------------------
// One key per (week, location): `af-cal:tt:YYYY-MM-DD:<handle>`, where the date
// is the Monday that labels the cache week (MYT); the week actually opens — and
// the key expires — at the prior Sunday 22:00 MYT. Gyms post a fresh weekly
// timetable each Sunday night, so a handle is scraped at most once per week and
// the Mon-00:00 MYT cron warms the fresh schedule; week rollover ⇒ new key
// namespace ⇒ everyone re-scrapes the new week's schedule automatically.
// Per-key (vs one blob) means concurrent renders never clobber each other's
// writes, and only scraped handles are written. Successes live to week end;
// errors are negative-cached for ERROR_TTL so a private/renamed/empty profile
// doesn't re-scrape Apify (slow, sync) on EVERY page load — it retries a few
// times a day instead. Upstash REST works on Vercel's read-only FS.

const ERROR_TTL = 6 * 60 * 60; // seconds; transient empties recover same day

// These gyms are in Malaysia (UTC+8, no DST), so "Sunday night" is anchored to
// MYT, not UTC — a UTC boundary would roll the cache mid-Sunday-afternoon local.
const MYT_OFFSET = 8 * 60 * 60 * 1000;

// ponytail: null when creds absent (local dev) so import doesn't throw; cache
// then no-ops and every request scrapes. Set creds to actually persist.
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? Redis.fromEnv()
    : null;

// The cache week opens at Sunday 22:00 MYT — the moment gyms have posted the new
// week's timetable; the weekly cron then fires 2h later (Mon 00:00 MYT) to fill
// any gaps the Mac sync missed. We anchor on
// that boundary by shifting the clock forward 2h so it reads as a Monday 00:00 in
// this frame, reuse the Monday math, then subtract the shift back for the real
// instant. The label stays the opening Monday's ISO date (stable namespace);
// only the real boundary moved 2h earlier, from Mon 00:00 to the prior Sun 22:00.
// Returns the label plus seconds until the *next* Sun-22:00 rollover so cache TTL
// and key share one source of truth.
const WEEK_BOUNDARY_SHIFT = 2 * 60 * 60 * 1000; // Sun 22:00 MYT = Mon 00:00 − 2h
function weekAnchor(now: number = Date.now()): {
  label: string;
  expiresInSecs: number;
} {
  // Shift into MYT wall-clock plus the 2h boundary shift, so Sun 22:00 MYT reads
  // as a Monday 00:00 here: reading UTC fields then yields the week's anchor day.
  const myt = new Date(now + MYT_OFFSET + WEEK_BOUNDARY_SHIFT);
  const sinceMon = (myt.getUTCDay() + 6) % 7; // days since this week's anchor Monday
  // Anchor Monday 00:00 (in the shifted frame), expressed as an "as-if-UTC" instant.
  const mondayAsUtc = Date.UTC(
    myt.getUTCFullYear(),
    myt.getUTCMonth(),
    myt.getUTCDate() - sinceMon,
  );
  const label = new Date(mondayAsUtc).toISOString().slice(0, 10); // YYYY-MM-DD
  // Undo MYT + boundary shift to get this week's real Sun-22:00 boundary, then +7d
  // is the next Sun-22:00 MYT — when Redis evicts the key.
  const thisRollover = mondayAsUtc - MYT_OFFSET - WEEK_BOUNDARY_SHIFT;
  const nextRollover = thisRollover + 7 * 24 * 60 * 60 * 1000;
  return {
    label,
    expiresInSecs: Math.max(1, Math.ceil((nextRollover - now) / 1000)),
  };
}

const keyFor = (handle: string) => `af-cal:tt:${weekAnchor().label}:${handle}`;

// Seconds until the next Sun-22:00 MYT rollover — Redis evicts the key then.
const secsToWeekEnd = (): number => weekAnchor().expiresInSecs;

async function readCache(
  handles: string[],
): Promise<Record<string, Timetable>> {
  if (!redis || !handles.length) return {};
  try {
    const vals = (await redis.mget<Timetable[]>(
      ...handles.map(keyFor),
    )) as (Timetable | null)[];
    const out: Record<string, Timetable> = {};
    handles.forEach((h, i) => {
      if (vals[i]) out[h] = vals[i]!;
    });
    return out;
  } catch {
    return {};
  }
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// A re-scrape that didn't land on a real timetable (keyword or pinned) is
// low-confidence — usually the newest unrelated promo after a monthly studio's
// schedule sank below the fetch window. Prefer a previously confident entry
// over clobbering it: check this week's key, then last week's (survives the
// Sunday rollover). null if no confident prior exists. Old-week Blob image URLs
// stay valid (permanent), so a carried-over entry still renders.
async function readPriorConfident(handle: string): Promise<Timetable | null> {
  if (!redis) return null;
  const keys = [
    keyFor(handle),
    `af-cal:tt:${weekAnchor(Date.now() - WEEK_MS).label}:${handle}`,
  ];
  try {
    const vals = (await redis.mget<Timetable[]>(
      ...keys,
    )) as (Timetable | null)[];
    return vals.find((v) => v && !v.error && v.matchedMonth) ?? null;
  } catch {
    return null;
  }
}

// ttlOverride forces a short TTL for a provisional write (e.g. a carry-over
// served while IG is blocking) so it re-scrapes soon instead of locking the week.
async function writeCache(
  entries: Timetable[],
  ttlOverride?: number,
): Promise<void> {
  if (!redis || !entries.length) return;
  try {
    const weekEx = secsToWeekEnd();
    const p = redis.pipeline();
    for (const t of entries) {
      p.set(keyFor(t.handle), t, {
        ex: ttlOverride ?? (t.error ? ERROR_TTL : weekEx),
      });
    }
    await p.exec();
  } catch {
    // ponytail: Redis unreachable → skip persist; next request re-scrapes.
  }
}

// ---- Public API -------------------------------------------------------------

// Division of labour: the weekly browser task (Sunday 22:30 MYT) BATCH-populates
// Redis — it scrapes every gym's IG page and POSTs the parsed timetables to
// /api/ingest → ingestTimetables. Apify is reserved for ON-DEMAND RETRY only: a
// normal page view / lazy card fetch never scrapes (serves cache, else the last
// confident entry, else an "awaiting sync" marker), so Apify runs are spent only
// when the user explicitly hits Retry or force-refresh on a card. See the
// `forced` gate in fetchTimetable below.

// Read-only: whatever's already cached. SSR uses this so first paint never
// blocks — uncached handles are fetched per-card via fetchTimetable.
export async function getCached(
  handles: string[],
): Promise<Record<string, Timetable>> {
  return readCache(handles);
}

// Manual ingest path. The weekly browser task scrapes each gym's IG page and
// hands the parsed timetables here; they're written straight into this week's
// cache under the same key + TTL a normal scrape would use, so the site renders
// them exactly as before — no Apify involved. Entries with a real schedule live
// to week end; error entries are negative-cached (ERROR_TTL) by writeCache.
//
// Images: the task sends the post's raw Instagram CDN URLs (which expire in
// ~4 days). We mirror them to Vercel Blob first (persistImages → permanent URLs),
// then cache those, so images stay viewable the whole week. Without a Blob token
// persistImages returns the IG URLs unchanged (they'll work for a few days, then
// the /api/img proxy is the only fallback). cdnUrl normalizes the host so the
// server-side mirror fetch succeeds regardless of which regional CDN host IG gave.
export async function ingestTimetables(entries: Timetable[]): Promise<void> {
  const mirrored = await Promise.all(
    entries.map(async (e) => {
      if (e.error || !e.images?.length) return e;
      const images = await persistImages(e.handle, e.images.map(cdnUrl));
      return { ...e, images };
    }),
  );
  await writeCache(mirrored);
}

// Shared "posts → cached Timetable" pipeline, used by the local Playwright sync
// script (scripts/sync.ts). Given a handle and its recent posts (newest first),
// it runs the same logic the Apify path uses: pick the likely timetable, let the
// vision model confirm + extract the schedule, carry forward a confident prior
// if this scrape didn't land on a real timetable, mirror images to Blob, cache,
// and return. `posts[*].images` should be raw IG URLs (cdnUrl-normalized here).
export async function syncTimetableFromPosts(
  handle: string,
  posts: Post[],
): Promise<Timetable> {
  const norm = posts.map((p) => ({ ...p, images: p.images.map(cdnUrl) }));
  if (!norm.length) {
    // Empty scrape (no posts / IG throttled this gym). NEVER clobber a good
    // entry: keep the last confident timetable if we have one (re-anchored into
    // this week so it survives the rollover); only negative-cache when there's
    // nothing to preserve.
    const prior = await readPriorConfident(handle);
    if (prior) {
      await writeCache([prior]);
      return prior;
    }
    const t = errorFor(handle, new Error("no posts"));
    await writeCache([t]);
    return t;
  }
  let t = choose(handle, norm);

  const fromPost = (p: Post, schedule: ClassSession[]): Timetable => ({
    handle,
    images: p.images,
    caption: p.caption,
    postUrl: p.url,
    takenAt: p.takenAt,
    matchedMonth: true,
    schedule,
  });

  // 1) Caption-first (cheap): if a post's caption already names the schedule
  // (keyword, or a weekly date-range / month caption), OCR just that one post —
  // no need to send every candidate's cover image to the classifier.
  let resolved = false;
  const capIdx = norm.findIndex((p) => captionLikelyTimetable(p.caption));
  if (capIdx >= 0) {
    const p = norm[capIdx];
    const schedule = await extractSchedule(p.images);
    if (schedule.length) {
      t = fromPost(p, schedule);
      resolved = true;
    }
  }

  // 2) Fallback (only when the caption gave nothing usable): the image classifier
  // looks at the candidate covers to catch caption-less / keyword-less timetables.
  if (!resolved) {
    const idx = await classifyTimetable(norm);
    if (idx >= 0 && norm[idx]) {
      const p = norm[idx];
      const schedule = await extractSchedule(p.images);
      if (schedule.length) t = fromPost(p, schedule);
    }
  }
  // Non-match scrape shouldn't clobber a confident schedule we already have.
  if (!t.matchedMonth) {
    const prior = await readPriorConfident(handle);
    if (prior) {
      await writeCache([prior]);
      return prior;
    }
  }
  if (!t.error) t.images = await persistImages(handle, t.images);
  await writeCache([t]);
  return t;
}

const IG_HEADERS = {
  "user-agent": "Mozilla/5.0",
  referer: "https://www.instagram.com/",
};

// Apify's Residential proxy needs the account's *proxy password*, which is
// distinct from APIFY_TOKEN but retrievable with it. Fetch once and memoize
// (Fluid Compute reuses the instance, so this is one lookup per warm function).
// null = no token or the lookup failed → caller just skips the proxy hop.
let proxyPwPromise: Promise<string | null> | undefined;
function apifyProxyPassword(): Promise<string | null> {
  const token = process.env.APIFY_TOKEN;
  if (!token) return Promise.resolve(null);
  return (proxyPwPromise ??= fetch(
    `https://api.apify.com/v2/users/me?token=${token}`,
    { cache: "no-store" },
  )
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => j?.data?.proxy?.password ?? null)
    .catch(() => null));
}

// Fetch an IG CDN image as bytes. Direct first — that works from a residential IP
// (the Mac sync). IG 403s datacenter IPs (the Vercel cron), so on ANY direct
// failure retry through Apify's Residential proxy, whose exit IPs IG treats as
// real users — this is what lets the cron mirror to Blob instead of storing a
// raw URL that dies in ~4 days. Returns null only if both routes fail.
// ponytail: the proxy hop is metered (Apify Residential, per-GB). It only fires
// when the direct fetch fails, so the Mac sync never pays for it; only the
// datacenter cron does. If IG ever stops blocking datacenter image fetches, the
// direct path wins and the proxy goes cold on its own.
async function fetchIgImage(
  url: string,
): Promise<{ buf: Buffer; contentType: string } | null> {
  try {
    const r = await fetch(url, {
      headers: IG_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok)
      return {
        buf: Buffer.from(await r.arrayBuffer()),
        contentType: r.headers.get("content-type") ?? "image/jpeg",
      };
  } catch {
    // network reset/timeout — fall through to the proxy
  }
  const pw = await apifyProxyPassword();
  if (!pw) return null;
  try {
    // undici's fetch (not the Next-patched global) so `dispatcher` is honored.
    // Dynamic import: undici pulls in node:net, which must stay out of the
    // client bundle (this lib's pure helpers are imported by client components).
    const { fetch: undiciFetch, ProxyAgent } = await import("undici");
    const dispatcher = new ProxyAgent({
      uri: "http://proxy.apify.com:8000",
      token: `Basic ${Buffer.from(`groups-RESIDENTIAL:${pw}`).toString("base64")}`,
    });
    const r = await undiciFetch(url, {
      headers: IG_HEADERS,
      dispatcher,
      signal: AbortSignal.timeout(30_000),
    });
    if (r.ok)
      return {
        buf: Buffer.from(await r.arrayBuffer()),
        contentType: r.headers.get("content-type") ?? "image/jpeg",
      };
  } catch {
    // proxy unreachable / IG still refused — give up, caller keeps the raw URL
  }
  return null;
}

// Mirror IG CDN images into Vercel Blob. IG signs its URLs with a ~4-day `oe=`
// expiry, but we cache a week — so the raw URLs can die before the entry does
// and every card breaks. Blob URLs are permanent, so the cached timetable stays
// viewable all week. Pathed by the cache week so each week's scrape writes fresh
// URLs (a force-refresh or rollover never serves a stale-cached old image).
// No token (local dev) → return IG URLs unchanged (served via /api/img).
async function persistImages(
  handle: string,
  urls: string[],
): Promise<string[]> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.warn(
      `[blob] no BLOB_READ_WRITE_TOKEN — keeping IG URLs for ${handle}`,
    );
    return urls;
  }
  if (!urls.length) return urls;
  const week = weekAnchor().label;
  return Promise.all(
    urls.map(async (u, i) => {
      // direct (residential) → Apify Residential proxy (datacenter cron)
      const img = await fetchIgImage(u);
      if (!img) {
        console.warn(
          `[blob] fetch ${handle}#${i} failed (direct+proxy); keeping IG URL`,
        );
        return u; // last resort: raw IG URL (proxy /api/img can still try for ~4 days)
      }
      try {
        // Buffer the bytes — passing a web ReadableStream to put() is unreliable
        // in Node and silently fails; a Buffer always works.
        const { url } = await put(`tt/${week}/${handle}-${i}.jpg`, img.buf, {
          access: "public",
          allowOverwrite: true,
          contentType: img.contentType,
        });
        return url;
      } catch (e) {
        console.error(
          `[blob] upload failed ${handle}#${i}: ${e instanceof Error ? e.message : e} — keeping IG URL`,
        );
        return u;
      }
    }),
  );
}

// Single handle: cache hit → return; else scrape just this one profile, mirror
// its images to Blob, cache, return. One Apify run per profile keeps each card
// independent and fast.
//
// Force restart (force/postUrl/limit) skips the cache read and overwrites the
// entry on success: when a gym posts an updated schedule mid-week the week-TTL
// cache still holds the older image, so a user-driven refresh re-scrapes and
// overwrites the stale entry. A post-link pick likewise sticks for the week.
export async function fetchTimetable(
  handle: string,
  opts: { force?: boolean; postUrl?: string; limit?: number } = {},
): Promise<Timetable> {
  // Only an explicit Retry / force-refresh (force, or a postUrl/limit override)
  // is allowed to spend an Apify run. Everything else — SSR, lazy on-scroll card
  // fetches — is cache-only: the weekly task is the batch populator.
  const forced = !!(opts.force || opts.postUrl || opts.limit != null);
  if (!forced) {
    const cached = await readCache([handle]);
    if (cached[handle]) return cached[handle];
    // Cache miss on a normal view: don't scrape. Serve the last confident entry
    // (carried across the rollover) or a soft "pending" marker until the next
    // weekly run — or until the user hits Retry, which forces an Apify scrape.
    const prior = await readPriorConfident(handle);
    if (prior) return prior;
    return errorFor(handle, new Error("Awaiting weekly sync"));
  }
  try {
    const posts = await scrapePosts(handle, {
      postUrl: opts.postUrl,
      limit: opts.limit,
    });
    let t = choose(handle, posts);
    if (opts.postUrl) {
      // User pasted the exact post → it IS the timetable. Skip classify, just
      // extract its schedule (this is what lights up the List view + filter).
      if (posts[0]) {
        const schedule = await extractSchedule(posts[0].images);
        if (schedule.length) t = { ...t, matchedMonth: true, schedule };
      }
    } else if (posts.length) {
      // Classify which post is the timetable, then extract on ONLY that image —
      // far more complete than one combined call juggling five candidates, and it
      // catches the image-only/unpinned miss the caption/pin heuristic can't see.
      const idx = await classifyTimetable(posts);
      if (idx >= 0 && posts[idx]) {
        const p = posts[idx];
        const schedule = await extractSchedule(p.images);
        // Only let vision override the heuristic when it actually extracted a
        // schedule. A classify hit with zero sessions is usually a misread promo
        // (e.g. a meme that name-drops classes) — don't badge it as a timetable;
        // let the caption/pin heuristic or the carried-forward prior stand.
        if (schedule.length) {
          t = {
            handle,
            images: p.images,
            caption: p.caption,
            postUrl: p.url,
            takenAt: p.takenAt,
            matchedMonth: true,
            schedule,
          };
        }
      }
    }
    // Non-match scrape (error, or just the newest unrelated post) shouldn't
    // overwrite a confident schedule we already have — keep the prior instead,
    // re-anchored into this week's key so it survives the rollover. An explicit
    // post-link force is intentional, so it bypasses this and stands as picked.
    if (!opts.postUrl && !t.matchedMonth) {
      const prior = await readPriorConfident(handle);
      if (prior) {
        await writeCache([prior]);
        return prior;
      }
    }
    if (!t.error) t.images = await persistImages(handle, t.images);
    // real timetable → week TTL; "no posts" → ERROR_TTL (negative-cached).
    await writeCache([t]);
    return t;
  } catch (e) {
    // Scrape failed or IG blocked Apify (403 / timeout / all-empty). Don't lock
    // the week: serve last week's confident timetable if we have one so the card
    // isn't blank, but cache it only briefly (ERROR_TTL) so we re-scrape and pick
    // up this week's post the moment IG unblocks. No prior → bare error, uncached,
    // retried next load.
    const prior = await readPriorConfident(handle);
    if (prior) {
      await writeCache([prior], ERROR_TTL);
      return prior;
    }
    return errorFor(handle, e);
  }
}

function errorFor(handle: string, e: unknown): Timetable {
  return {
    handle,
    images: [],
    caption: "",
    postUrl: null,
    takenAt: null,
    matchedMonth: false,
    error: e instanceof Error ? e.message : "fetch failed",
  };
}
