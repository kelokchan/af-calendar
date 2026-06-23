// Instagram fetch via Apify (apify/instagram-scraper) — paid per result, but
// results live in Redis cached for the whole calendar month, so a profile is
// only scraped once per month (timetables are monthly). Cards fetch on demand
// (one profile per request); new month → keys expire → re-scraped as viewed.

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
  timestamp?: string;
  type?: string;
  isPinned?: boolean;
};

async function fetchViaApify(handles: string[]): Promise<Timetable[]> {
  const token = process.env.APIFY_TOKEN!;
  const res = await fetch(
    `https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items?token=${token}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        directUrls: handles.map((h) => `https://www.instagram.com/${h}/`),
        resultsType: "posts",
        resultsLimit: 4, // per profile; viewed early month, fresh timetable sits at top
        onlyPostsNewerThan: "2 months", // stop early on active gyms — fewer billed results
        addParentData: false,
      }),
      // ponytail: cap the sync scrape so a stuck Apify run can't hang the request
      // forever. Called per-profile, so this is one profile's budget.
      signal: AbortSignal.timeout(120_000),
    },
  );
  if (!res.ok) throw new Error(`Apify HTTP ${res.status}`);
  const items: ApifyItem[] = await res.json();

  // Group posts by username, preserving Apify's order (newest first).
  const byUser = new Map<string, Post[]>();
  for (const it of items) {
    const u = it.ownerUsername;
    if (!u) continue;
    const images = it.images?.length
      ? it.images
      : it.displayUrl
        ? [it.displayUrl]
        : [];
    const post: Post = {
      caption: it.caption ?? "",
      images: images.map(cdnUrl),
      url: it.url ?? null,
      takenAt: it.timestamp
        ? Math.floor(Date.parse(it.timestamp) / 1000)
        : null,
      pinned: !!it.isPinned,
    };
    (byUser.get(u) ?? byUser.set(u, []).get(u)!).push(post);
  }
  return handles.map((h) => choose(h, byUser.get(h) ?? []));
}

// ---- Redis cache ------------------------------------------------------------
// One key per (month, location): `af-cal:tt:YYYY-MM:<handle>`, expiring at month
// end (UTC). A cached handle is never re-scraped that month; month rollover ⇒
// new key namespace ⇒ rebuild. Per-key (vs one blob) means concurrent renders
// never clobber each other's writes, and only scraped handles are written.
// Successes live to month end; errors are negative-cached for ERROR_TTL so a
// private/renamed/empty profile doesn't re-scrape Apify (slow, sync) on EVERY
// page load — it retries a few times a day instead. Upstash REST works on
// Vercel's read-only FS.

const ERROR_TTL = 6 * 60 * 60; // seconds; transient empties recover same day

// ponytail: null when creds absent (local dev) so import doesn't throw; cache
// then no-ops and every request scrapes. Set creds to actually persist.
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? Redis.fromEnv()
    : null;

const keyFor = (handle: string) =>
  `af-cal:tt:${new Date().toISOString().slice(0, 7)}:${handle}`; // YYYY-MM (UTC)

// Seconds until the start of next month (UTC) — Redis evicts the key then.
function secsToMonthEnd(): number {
  const now = Date.now();
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return Math.ceil((next - now) / 1000);
}

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
    const monthEx = secsToMonthEnd();
    const p = redis.pipeline();
    for (const t of entries) {
      p.set(keyFor(t.handle), t, { ex: t.error ? ERROR_TTL : monthEx });
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
// expiry, but we cache a month — so the raw URLs die mid-month and every card
// breaks. Blob URLs are permanent, so the cached timetable stays viewable all
// month. No token (local dev) → return IG URLs unchanged (served via /api/img).
async function persistImages(
  handle: string,
  urls: string[],
): Promise<string[]> {
  if (!process.env.BLOB_READ_WRITE_TOKEN || !urls.length) return urls;
  const month = new Date().toISOString().slice(0, 7);
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
        const { url } = await put(`tt/${month}/${handle}-${i}.jpg`, res.body!, {
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
export async function fetchTimetable(handle: string): Promise<Timetable> {
  const cached = await readCache([handle]);
  if (cached[handle]) return cached[handle];
  try {
    const [t] = await fetchViaApify([handle]);
    if (!t.error) t.images = await persistImages(handle, t.images);
    // real timetable → month TTL; "no posts" → ERROR_TTL (negative-cached).
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
