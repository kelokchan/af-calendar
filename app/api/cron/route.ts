import { LOCATIONS } from "@/lib/locations";
import { fetchTimetable } from "@/lib/instagram";

// Weekly pre-warm via Apify. The Vercel cron (Sun 22:00 MYT — see vercel.json)
// fires right at the Sunday-night cache rollover and BATCH-populates Redis: every
// handle is Apify-scraped before any visitor arrives → instant first paint all
// week. A partial run (slow scrape, timeout, IG block on a handle) is fine — the
// carried-forward prior or the "awaiting sync" marker covers the tail.
//
// `force: true` is required: a normal fetchTimetable read is cache-only (Apify is
// reserved for explicit force/retry), so without it the cron would just read the
// just-expired cache and never scrape. force bypasses the cache and spends one
// Apify run per handle — which is the whole point of the weekly populator.
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
  return Response.json({ scraped: handles.length, ok, failed });
}
