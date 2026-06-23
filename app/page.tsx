import { LOCATIONS, KEPONG } from "@/lib/locations";
import { getCached } from "@/lib/instagram";
import Grid from "./Grid";

// Nearest to Kepong first. Squared-degree distance is fine for ranking.
const SORTED = [...LOCATIONS].sort(
  (a, b) =>
    (a.lat - KEPONG.lat) ** 2 +
    (a.lng - KEPONG.lng) ** 2 -
    ((b.lat - KEPONG.lat) ** 2 + (b.lng - KEPONG.lng) ** 2),
);

export const revalidate = 86400; // rebuild grid daily (timetables change monthly)

const MONTH = new Date().toLocaleString("en-US", {
  month: "long",
  year: "numeric",
});

export default async function Home() {
  // Read-only cache → instant first paint. Uncached cards self-fetch client-side.
  const byHandle = await getCached(SORTED.map((l) => l.handle));

  return (
    <main className="min-h-screen">
      <header className="sticky top-0 z-20 border-b-2 border-line bg-canvas">
        <div className="mx-auto flex w-full max-w-[120rem] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="flex h-10 w-10 items-center justify-center rounded-md border-2 border-line bg-accent font-mono text-sm font-bold tracking-tighter text-white shadow-[3px_3px_0_0_var(--shadow)]"
            >
              AF
            </span>
            <div>
              <h1 className="text-base font-bold uppercase leading-tight tracking-tight text-ink sm:text-lg">
                Class Timetables
              </h1>
              <p className="font-mono text-[11px] uppercase tracking-wider text-muted">
                Anytime Fitness
              </p>
            </div>
          </div>

          <span className="inline-flex items-center gap-1.5 rounded-md border-2 border-line bg-surface px-3 py-1.5 font-mono text-xs font-bold uppercase tracking-wide text-ink shadow-[3px_3px_0_0_var(--shadow)]">
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
    </main>
  );
}
