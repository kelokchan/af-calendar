// Instagram fetch via Apify (apify/instagram-scraper) — paid per result, but
// results live in Redis cached for the whole week, so a profile is only scraped
// once per week (gyms post a fresh weekly timetable each Sunday night). Cards
// fetch on demand (one profile per request); each Sunday-night rollover → keys
// expire → re-scraped as viewed. A force-refresh re-scrapes a profile on demand.

import { Redis } from "@upstash/redis";
import { put } from "@vercel/blob";

export type Timetable = {
  handle: string;
  images: string[]; // all images of the chosen post (carousel = multiple)
  caption: string;
  postUrl: string | null;
  takenAt: number | null;
  matchedMonth: boolean; // caption mentions current month / timetable keyword
  error?: string;
};

// IG returns region-local image hosts (`*.fna.fbcdn.net`, `scontent-<pop>`) that
// aren't reachable from servers. The URL signature is path-bound, not host-bound,
// so rewriting to the global CDN host makes the same image fetchable everywhere.
export const cdnUrl = (u: string) =>
  u.replace(/^https:\/\/[^/]+/, "https://scontent.cdninstagram.com");

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
    matchedMonth: looksLikeTimetable(match.caption),
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

async function fetchViaApify(
  handles: string[],
  opts: ScrapeOpts = {},
): Promise<Timetable[]> {
  const token = process.env.APIFY_TOKEN!;
  const body: Record<string, unknown> = {
    directUrls: opts.postUrl
      ? [opts.postUrl]
      : handles.map((h) => `https://www.instagram.com/${h}/`),
    resultsType: "posts",
    resultsLimit: opts.limit ?? 4, // per profile; the fresh weekly timetable sits at top
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

  // Direct post link is always one handle → take the returned post(s) as-is,
  // skipping the username grouping (owner may differ in case from the handle).
  if (opts.postUrl) return [choose(handles[0], items.map(toPost))];

  // Group posts by username, preserving Apify's order (newest first).
  const byUser = new Map<string, Post[]>();
  for (const it of items) {
    const u = it.ownerUsername;
    if (!u) continue;
    (byUser.get(u) ?? byUser.set(u, []).get(u)!).push(toPost(it));
  }
  return handles.map((h) => choose(h, byUser.get(h) ?? []));
}

// ---- Redis cache ------------------------------------------------------------
// One key per (week, location): `af-cal:tt:YYYY-MM-DD:<handle>`, where the date
// is the Monday that opens the cache week (MYT) and the key expires at the next
// Sunday-night boundary. Gyms post a fresh weekly timetable each Sunday night,
// so a handle is scraped at most once per week; week rollover ⇒ new key
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

// The week's anchor: the Monday 00:00 MYT that opens the current cache week
// (i.e. the boundary right after the previous Sunday night). Returns both a
// stable namespace label and the seconds left until the *next* Sunday-night
// rollover so cache TTL and key share one source of truth.
function weekAnchor(now: number = Date.now()): {
  label: string;
  expiresInSecs: number;
} {
  // Shift into MYT wall-clock: reading UTC fields of the shifted date yields
  // Malaysian local Y/M/D/day.
  const myt = new Date(now + MYT_OFFSET);
  const sinceMon = (myt.getUTCDay() + 6) % 7; // days since this week's Monday
  // Monday 00:00 of the current MYT week, expressed as an "as-if-UTC" instant.
  const mondayAsUtc = Date.UTC(
    myt.getUTCFullYear(),
    myt.getUTCMonth(),
    myt.getUTCDate() - sinceMon,
  );
  const label = new Date(mondayAsUtc).toISOString().slice(0, 10); // YYYY-MM-DD
  // Next Monday 00:00 MYT, back in real epoch ms, is when Redis evicts the key.
  const nextRollover = mondayAsUtc + 7 * 24 * 60 * 60 * 1000 - MYT_OFFSET;
  return {
    label,
    expiresInSecs: Math.max(1, Math.ceil((nextRollover - now) / 1000)),
  };
}

const keyFor = (handle: string) => `af-cal:tt:${weekAnchor().label}:${handle}`;

// Seconds until the next Sunday-night rollover (MYT) — Redis evicts the key then.
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

async function writeCache(entries: Timetable[]): Promise<void> {
  if (!redis || !entries.length) return;
  try {
    const weekEx = secsToWeekEnd();
    const p = redis.pipeline();
    for (const t of entries) {
      p.set(keyFor(t.handle), t, { ex: t.error ? ERROR_TTL : weekEx });
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
    const [t] = await fetchViaApify([handle], {
      postUrl: opts.postUrl,
      limit: opts.limit,
    });
    if (!t.error) t.images = await persistImages(handle, t.images);
    // real timetable → week TTL; "no posts" → ERROR_TTL (negative-cached).
    await writeCache([t]);
    return t;
  } catch (e) {
    // Infra failure (403/timeout): serve error, don't cache → retries next load.
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
