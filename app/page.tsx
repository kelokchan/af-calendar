import { LOCATIONS, KEPONG } from "@/lib/locations";
import { getCached } from "@/lib/instagram";
import Grid from "./Grid";
import ScrollTop from "./ScrollTop";

// Nearest to Kepong first. Squared-degree distance is fine for ranking.
const SORTED = [...LOCATIONS].sort(
  (a, b) =>
    (a.lat - KEPONG.lat) ** 2 +
    (a.lng - KEPONG.lng) ** 2 -
    ((b.lat - KEPONG.lat) ** 2 + (b.lng - KEPONG.lng) ** 2),
);

// Rebuild the grid hourly. This does NOT scrape Apify — getCached is a read-only
// Redis mget; Apify only runs on a cache miss (once per handle per week) or a
// force refresh. Timetables refresh weekly (Sunday-night cache rollover, see
// lib/instagram), but the SSR shell bakes in whatever's cached at build time, so
// a daily rebuild could keep serving last week's images for up to 24h after the
// rollover. Hourly just lets the shell pick up the new week's cached data
// promptly; uncached cards still self-fetch client-side.
export const revalidate = 3600;

const MONTH = new Date().toLocaleString("en-US", {
  month: "long",
  year: "numeric",
});

export default async function Home() {
  // Read-only cache → instant first paint. Uncached cards self-fetch client-side.
  const byHandle = await getCached(SORTED.map((l) => l.handle));

  return (
    <main className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-canvas/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[120rem] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/af-logo.webp"
              alt="Anytime Fitness"
              className="h-8 w-auto"
            />
          </div>

          <span className="rounded-full bg-surface-2 px-3 py-1 text-xs font-medium text-muted">
            {MONTH}
          </span>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[120rem] px-4 py-5 sm:px-6 sm:py-6">
        <Grid
          items={SORTED.map((loc) => ({
            name: loc.name,
            handle: loc.handle,
            lat: loc.lat,
            lng: loc.lng,
            t: byHandle[loc.handle],
          }))}
        />
      </div>

      <ScrollTop />
    </main>
  );
}
