import { LOCATIONS } from "@/lib/locations";
import { fetchTimetable, getCached } from "@/lib/instagram";

// Weekly GAP-FILLER via Apify. The PRIMARY populator is the Sunday-22:30-MYT Mac
// sync (Playwright → /api/ingest): it writes full-res carousel images mirrored to
// permanent Blob URLs plus the parsed schedule straight to Redis. This cron is
// only a safety net for handles that sync missed (Mac asleep, IG threw on a gym,
// etc.). It runs LATER — Mon 00:00 MYT, see vercel.json — AFTER the rollover, the
// Mac sync, and the Sunday-night posting window, and force-scrapes ONLY the
// handles that don't already hold this week's confident timetable.
//
// Why gap-fill instead of re-scraping everything: a blanket `force: true` over
// all handles OVERWROTE the sync's good entries with the profile-scraper's
// shallow, cover-only images (and, when the Blob mirror fetch was IG-blocked, raw
// IG CDN URLs that expire in ~4 days) — that's the "cron broke all my images"
// regression. Firing at the 22:00 rollover, before gyms posted, also cached last
// week's post as this week ("schedule incorrect"). Skipping already-confident
// handles fixes both: we never touch a good entry, only fill real blanks.
//
// `force: true` on the gap handles is required: a normal fetchTimetable read is
// cache-only (Apify is reserved for explicit force/retry), so without it the cron
// would just re-read the same blank cache and never scrape.
export const dynamic = "force-dynamic";
export const maxDuration = 300; // Vercel ceiling; a partial run is fine (lazy self-heals the tail)

// ponytail: 12 concurrent scrapes per wave. Bounded by Apify run concurrency, not
// by our throughput. If worst-case ~120s scrapes push a wave past maxDuration, the
// unscraped tail just falls to the lazy self-fetch. Bump or trim if the Apify
// plan's concurrency limit changes.
const CHUNK = 12;

// A cached entry counts as "confident" (leave it alone) when it isn't an error
// and matched a real timetable. Anything else — missing, negative-cached error,
// or a low-confidence non-match — is a gap worth force-scraping.
const isConfident = (
  t: { error?: string; matchedMonth: boolean } | undefined,
) => !!t && !t.error && t.matchedMonth;

export async function GET(req: Request) {
  // Vercel auto-sends this header on cron invocations once CRON_SECRET is set.
  // Fail closed: if the secret is unset/mismatched the endpoint stays locked, so
  // nobody can trigger paid Apify runs by hitting the URL. Set CRON_SECRET in the
  // Vercel project env for the cron (and any manual trigger) to work.
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`)
    return new Response("Unauthorized", { status: 401 });

  const handles = LOCATIONS.map((l) => l.handle);
  // Read what this week already holds (the Mac sync wrote most of it) and scrape
  // ONLY the handles still missing a confident timetable. Never re-scrape a good
  // entry — that's what used to clobber the sync's images and schedules.
  const cached = await getCached(handles);
  const todo = handles.filter((h) => !isConfident(cached[h]));

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < todo.length; i += CHUNK) {
    const results = await Promise.all(
      todo.slice(i, i + CHUNK).map((h) =>
        // fetchTimetable never throws (it returns an error Timetable); the reject
        // arm is just belt-and-suspenders.
        fetchTimetable(h, { force: true }).then(
          (t) => !t.error,
          () => false,
        ),
      ),
    );
    for (const good of results)
      if (good) ok++;
      else failed++;
  }
  return Response.json({
    handles: handles.length,
    skipped: handles.length - todo.length, // already-confident, left untouched
    filled: todo.length,
    ok,
    failed,
  });
}
