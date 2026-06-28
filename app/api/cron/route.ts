import { LOCATIONS } from "@/lib/locations";
import { fetchTimetable } from "@/lib/instagram";

// Weekly pre-warm. The Vercel cron (Sun 22:00 MYT — see vercel.json) fires right
// at the Sunday-night cache rollover, so every handle is scraped into Redis
// before any visitor arrives → instant first paint all week. Cards still
// self-fetch on a cache miss, so a partial run (a slow Apify scrape, a timeout)
// self-heals on view — the cron needn't be all-or-nothing.
//
// fetchTimetable reads cache first; the week's keys expire exactly at the Sun
// 22:00 MYT rollover (the cron's slot), so each call lands on the scrape path.
// No `force` needed — and an early-bird visitor who already warmed a handle just
// returns a cache hit here, saving an Apify run.
export const dynamic = "force-dynamic";
export const maxDuration = 300; // Vercel ceiling; a partial run is fine (lazy self-heals the tail)

// ponytail: 12 concurrent → 3 waves over 36 handles. Bounded by Apify run
// concurrency, not by our throughput. If worst-case ~120s scrapes push a wave
// past maxDuration, the unscraped tail just falls to the lazy self-fetch. Bump
// or trim if the Apify plan's concurrency limit changes.
const CHUNK = 12;

export async function GET(req: Request) {
  // Vercel auto-sends this header on cron invocations once CRON_SECRET is set.
  // Fail closed: if the secret is unset/mismatched the endpoint stays locked, so
  // nobody can trigger 36 paid Apify runs by hitting the URL. Set CRON_SECRET in
  // the Vercel project env for the cron (and any manual trigger) to work.
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`)
    return new Response("Unauthorized", { status: 401 });

  const handles = LOCATIONS.map((l) => l.handle);
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < handles.length; i += CHUNK) {
    const results = await Promise.all(
      handles.slice(i, i + CHUNK).map((h) =>
        // fetchTimetable never throws (it returns an error Timetable); the reject
        // arm is just belt-and-suspenders.
        fetchTimetable(h).then(
          (t) => !t.error,
          () => false,
        ),
      ),
    );
    for (const good of results)
      if (good) ok++;
      else failed++;
  }
  return Response.json({ scraped: handles.length, ok, failed });
}
