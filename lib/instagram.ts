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

// Normalized post, source-agnostic.
type Post = {
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
  error?: string; // set (e.g. "no_items") when IG blocked the scrape → stub item, no media
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

// opts (force restart): postUrl scrapes that exact post (overrides the profile
// scrape, takes precedence); limit overrides the default depth. Either one drops
// the age cap so the count is the only limit and old pinned posts stay reachable.
type ScrapeOpts = { postUrl?: string; limit?: number };

// One profile (or one post link) → its posts, newest first. Single-handle, so
// every returned item belongs to this handle; no username grouping needed.
async function scrapePosts(
  handle: string,
  opts: ScrapeOpts = {},
): Promise<Post[]> {
  const token = process.env.APIFY_TOKEN!;
  const body: Record<string, unknown> = {
    directUrls: opts.postUrl
      ? [opts.postUrl]
      : [`https://www.instagram.com/${handle}/`],
    resultsType: "posts",
    resultsLimit: opts.limit ?? 4, // newest few only; the timetable is the current/pinned post, rarely buried deep. Age cap below further bounds cost.
    addParentData: false,
  };
  // Default profile scrape only → cap by age to cut billed results. A forced
  // post-link or custom count means "fetch what I asked", so don't age-filter.
  if (!opts.postUrl && opts.limit == null) body.onlyPostsNewerThan = "2 months"; // stop early on active gyms — fewer billed results
  const res = await fetch(
    `https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items?token=${token}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // ponytail: cap the sync scrape so a stuck Apify run can't hang the request
      // forever. Called per-profile, so this is one profile's budget.
      signal: AbortSignal.timeout(120_000),
    },
  );
  if (!res.ok) throw new Error(`Apify HTTP ${res.status}`);
  const items: ApifyItem[] = await res.json();
  // IG intermittently blocks Apify's logged-out scraper; it then returns stub
  // items carrying an `error` ("no_items" / "Empty or private data") and no media.
  // An all-stub response is a transient BLOCK, not "this profile has no posts" —
  // throw so the caller serves last week's timetable on a short TTL and re-scrapes
  // soon, instead of caching an empty/wrong pick for the whole week. A partial
  // block (some real, some stub) just drops the stubs.
  const real = items.filter((it) => !it.error);
  if (items.length && !real.length)
    throw new Error(
      `Apify blocked (${items.length} empty items) for ${handle}`,
    );
  return real.map(toPost);
}

// ---- Vision: identify the timetable post + extract its schedule -------------
// The dominant miss is an image-only, plain-caption, unpinned timetable that a
// newer promo outranks — invisible to caption/pin heuristics, legible only in
// the image. A cheap vision model looks at the top candidates, says which one
// (if any) IS the weekly class timetable, and extracts its sessions in the same
// call (powering the list view + cross-gym filter). Cache-miss path only, so
// it runs ~once per gym per week.

const N_CANDIDATES = 5; // top recent posts shown to the model; the miss-case timetable is recent, just outranked

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
// the Sun-22:00 cron warms the fresh schedule; week rollover ⇒ new key
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
// week's timetable, and when the weekly cron fires to pre-warm it. We anchor on
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

// Read-only: whatever's already cached. SSR uses this so first paint never
// blocks on Apify — uncached handles are fetched per-card via fetchTimetable.
export async function getCached(
  handles: string[],
): Promise<Record<string, Timetable>> {
  return readCache(handles);
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
  if (!process.env.BLOB_READ_WRITE_TOKEN || !urls.length) return urls;
  const week = weekAnchor().label;
  return Promise.all(
    urls.map(async (u, i) => {
      try {
        const res = await fetch(u, {
          headers: {
            "user-agent": "Mozilla/5.0",
            referer: "https://www.instagram.com/",
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return u; // fall back to IG URL (proxy can still try)
        const { url } = await put(`tt/${week}/${handle}-${i}.jpg`, res.body!, {
          access: "public",
          allowOverwrite: true,
          contentType: res.headers.get("content-type") ?? "image/jpeg",
        });
        return url;
      } catch {
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
  if (!opts.force && !opts.postUrl && opts.limit == null) {
    const cached = await readCache([handle]);
    if (cached[handle]) return cached[handle];
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
