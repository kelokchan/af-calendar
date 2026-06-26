"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { ChevronDown, LayoutGrid, List, ArrowUpRight, X } from "lucide-react";
import Card from "./Card";
import {
  to12h,
  titleCase,
  type Timetable,
  type ClassSession,
} from "@/lib/instagram";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const DAY_LABEL: Record<(typeof DAYS)[number], string> = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
  Sun: "Sunday",
};

// "HH:MM" → minutes-into-week, so a session orders/compares against "now".
const toMin = (t: string) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
const weekPos = (s: ClassSession) =>
  DAYS.indexOf(s.day) * 1440 + toMin(s.startTime);

// "From" time options, 6 AM–10 PM. value is 24h "HH:00" to match parsed
// startTime (string compare); label is friendly 12-hour.
const TIMES = Array.from({ length: 17 }, (_, k) => {
  const h = k + 6;
  return {
    value: `${String(h).padStart(2, "0")}:00`,
    label: `${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}`,
  };
});

// Pull a time out of free text: "7pm", "7 pm", "7:30pm", or 24h "19:00".
// Returns the 24h "HH:MM" plus the matched substring (so callers can strip it).
function parseTime(q: string): { time: string; raw: string } {
  let m = q.match(/(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i);
  if (m) {
    let h = +m[1] % 12;
    if (m[3].toLowerCase() === "pm") h += 12;
    return { time: `${String(h).padStart(2, "0")}:${m[2] ?? "00"}`, raw: m[0] };
  }
  m = q.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m) return { time: `${m[1].padStart(2, "0")}:${m[2]}`, raw: m[0] };
  return { time: "", raw: "" };
}

// Day words → our codes. Full names + common abbreviations.
// ponytail: bare "sun"/"sat" are also day words, so "sun salutation" would read
// as Sunday — acceptable; AF class names aren't day words in practice.
const DAY_WORDS: Record<string, (typeof DAYS)[number]> = {
  monday: "Mon",
  mon: "Mon",
  tuesday: "Tue",
  tues: "Tue",
  tue: "Tue",
  wednesday: "Wed",
  wed: "Wed",
  thursday: "Thu",
  thurs: "Thu",
  thu: "Thu",
  friday: "Fri",
  fri: "Fri",
  saturday: "Sat",
  sat: "Sat",
  sunday: "Sun",
  sun: "Sun",
};
// Longest-first so "tuesday" wins over "tue".
const DAY_RE = new RegExp(
  `\\b(${Object.keys(DAY_WORDS)
    .sort((a, b) => b.length - a.length)
    .join("|")})\\b`,
);

// Split a query like "yoga at river city at 10 on monday" into search tokens +
// a day + a time. "at"/"on"/"@" are dropped; each remaining token must appear in
// the gym OR class text (see matchSessionIn). Word order is free and the day
// word can sit anywhere ("yoga 10 monday" works without "on").
function parseQuery(raw: string): {
  tokens: string[];
  time: string;
  day: string;
} {
  let work = raw.trim().toLowerCase();

  // Day first; stripping it (and trimming) leaves a clean string so a trailing
  // bare hour like "yoga 10 monday" → "yoga 10" still reads as a time.
  let day = "";
  const dm = work.match(DAY_RE);
  if (dm) {
    day = DAY_WORDS[dm[1]];
    work = work.replace(dm[0], " ").trim();
  }

  let { time, raw: stripped } = parseTime(work);
  if (!time) {
    // Bare hour → that hour directly: "at 7" / "@7" / a trailing "7" become
    // 07:00 (i.e. 7am); "at 19" → 19:00 (7pm). Scoped to after "at"/"@" or
    // end-of-query so "level 3 flow" stays a plain text search.
    // ponytail: ambiguous by nature — "at 3" always reads as 3am, not 3pm.
    const m = work.match(/(?:\bat\s+|@\s*)(\d{1,2})\b|\b(\d{1,2})$/);
    const h = m ? +(m[1] ?? m[2]) : -1;
    if (h >= 0 && h <= 23) {
      time = `${String(h).padStart(2, "0")}:00`;
      stripped = m![0];
    }
  }
  if (stripped) work = work.replace(stripped, " ");

  const tokens = work
    .split(/[\s,]+/)
    .filter((t) => t && t !== "at" && t !== "on" && t !== "@");
  return { tokens, time, day };
}

// Shared control styling so every filter field is the same flat element — the
// gym search and the class search must look identical. Hairline border, accent
// ring on focus, no chrome at rest.
const FIELD =
  "h-10 rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25";
const SELECT =
  "h-10 rounded-lg border border-line bg-surface px-2.5 text-sm text-ink transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25";

// Select with a custom chevron: appearance-none drops the browser arrow (which
// sits cramped against the right edge) and we place our own with real padding.
function Select({
  value,
  onChange,
  ariaLabel,
  className = "",
  children,
}: {
  value: string;
  onChange: (e: ChangeEvent<HTMLSelectElement>) => void;
  ariaLabel: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`relative ${className}`}>
      <select
        value={value}
        onChange={onChange}
        aria-label={ariaLabel}
        className={`${SELECT} w-full appearance-none pr-9`}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
      />
    </div>
  );
}

type Item = {
  name: string;
  handle: string;
  lat: number;
  lng: number;
  t?: Timetable;
};

export default function Grid({ items }: { items: Item[] }) {
  const [q, setQ] = useState("");
  // null = use server order (nearest Kepong) — the fallback when geolocation is denied/unavailable.
  const [origin, setOrigin] = useState<{ lat: number; lng: number } | null>(
    null,
  );

  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        setOrigin({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {}, // denied/timeout → keep Kepong default
      { timeout: 8000 },
    );
  }, []);

  // Squared-degree distance — fine for ranking near the equator. Re-sort only if we have a fix.
  const ranked = origin
    ? [...items].sort(
        (a, b) =>
          (a.lat - origin.lat) ** 2 +
          (a.lng - origin.lng) ** 2 -
          ((b.lat - origin.lat) ** 2 + (b.lng - origin.lng) ** 2),
      )
    : items;

  // One search box covers both gym name/handle AND class name. day/from are
  // class-only facets. startTime is zero-padded "HH:MM", so string compare
  // orders it correctly.
  const [branch, setBranch] = useState(""); // "" = all branches
  const [day, setDay] = useState(""); // "" = any day
  const [from, setFrom] = useState(""); // "HH:MM" or ""
  const [view, setView] = useState<"grid" | "list">("list");

  // Branch dropdown options — every gym, alphabetical.
  const branches = [...items]
    .map((i) => i.name)
    .sort((a, b) => a.localeCompare(b));

  // Minutes-into-week of "now", for dimming classes that have already passed.
  // null until mount so SSR/first paint match (nothing dimmed), then it fills in.
  // rAF sets it right after hydration; the interval keeps it fresh as time passes
  // (both async, so no synchronous setState-in-effect).
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => {
      // Schedules are Malaysia-local, so compute "now" in MYT (UTC+8, no DST)
      // regardless of the viewer's device timezone — shift the epoch by +8h,
      // then read UTC fields as MYT wall-clock. getUTCDay() is 0=Sun..6=Sat;
      // our week is Mon-first.
      const d = new Date(Date.now() + 8 * 3600_000);
      setNow(
        ((d.getUTCDay() + 6) % 7) * 1440 +
          d.getUTCHours() * 60 +
          d.getUTCMinutes(),
      );
    };
    const raf = requestAnimationFrame(tick);
    const id = setInterval(tick, 60_000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(id);
    };
  }, []);

  // Parse the search box once. A typed day/time (e.g. "monday", "7pm") fills the
  // Day/From facets unless those dropdowns are already set (the dropdown wins).
  const { tokens, time: qTime, day: qDay } = parseQuery(q);
  const fromTime = from || qTime;
  const dayFacet = day || qDay;
  const facetActive = tokens.length > 0 || !!dayFacet || !!fromTime;

  // Per-gym session matcher: every token must land somewhere in the gym
  // name/handle + class + instructor, so "yoga river city" matches a yoga class
  // at River City. The class must also fit the day/from facets.
  const matchSessionIn = (it: Item) => (s: ClassSession) =>
    tokens.every((t) =>
      `${it.name} ${it.handle} ${s.className} ${s.instructor ?? ""}`
        .toLowerCase()
        .includes(t),
    ) &&
    (!dayFacet || s.day === dayFacet) &&
    (!fromTime || s.startTime >= fromTime);

  // Gym matched by name alone (every token lands in the gym name/handle).
  const gymTokenMatch = (it: Item) =>
    tokens.every((t) => `${it.name} ${it.handle}`.toLowerCase().includes(t));

  const inBranch = (it: Item) => !branch || it.name === branch;
  const scope = ranked.filter(inBranch);

  const shown = scope.filter((it) => {
    if (!facetActive) return true;
    const hasMatch = it.t?.schedule?.some(matchSessionIn(it)) ?? false;
    // a day/time facet means the gym must have a class that fits.
    if (dayFacet || fromTime) return hasMatch;
    // text only → the gym name matches, or one of its classes does.
    return gymTokenMatch(it) || hasMatch;
  });

  // List view: every gym's classes flattened into one timeline, filtered by the
  // same facets and sorted Mon→Sun by start time. A gym hit purely by name shows
  // all its classes; otherwise only the class rows that match.
  const rowsFor = (it: Item) => {
    const sched = it.t?.schedule ?? [];
    if (dayFacet || fromTime) return sched.filter(matchSessionIn(it));
    if (tokens.length)
      return gymTokenMatch(it) ? sched : sched.filter(matchSessionIn(it));
    return sched;
  };
  const sessionRows =
    view === "list"
      ? scope
          .flatMap((it) =>
            rowsFor(it).map((s) => ({
              gym: it.name,
              handle: it.handle,
              // Link to the gym's timetable post; fall back to its profile.
              post: it.t?.postUrl ?? `https://instagram.com/${it.handle}`,
              s,
              pos: weekPos(s),
            })),
          )
          .sort((a, b) => a.pos - b.pos)
      : [];
  // The very next class in the week — the first row not yet passed. Accented so
  // "what's coming up" is obvious at a glance.
  const nextPos =
    now == null ? -1 : (sessionRows.find((r) => r.pos >= now)?.pos ?? -1);

  return (
    <>
      {/* Filter toolbar — search box + view toggle on top; Branch / Day / From
          dropdowns below. Search understands a mixed query like
          "yoga at river city at 7pm" (class + branch + time at once). */}
      <div
        data-toolbar
        className="sticky top-14 z-10 mb-8 flex flex-col gap-2.5 bg-canvas py-3"
      >
        <div className="flex flex-row items-center gap-2.5">
          <div className="relative min-w-0 flex-1">
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Yoga at River City at 7pm"
              className={`${FIELD} w-full ${q ? "pr-10" : ""}`}
            />
            {q && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQ("")}
                className="absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {/* Cards (per-gym) ↔ List (one global timeline) toggle. */}
          <div className="flex h-10 shrink-0 items-center rounded-lg border border-line bg-surface p-0.5">
            {(["grid", "list"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                aria-pressed={view === v}
                className={`inline-flex h-full items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors ${
                  view === v
                    ? "bg-surface-2 text-ink"
                    : "text-muted hover:text-ink"
                }`}
              >
                {v === "grid" ? (
                  <LayoutGrid className="h-4 w-4" />
                ) : (
                  <List className="h-4 w-4" />
                )}
                <span className="hidden sm:inline">
                  {v === "grid" ? "Cards" : "List"}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Select
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            ariaLabel="Branch"
            className="basis-full sm:basis-auto sm:flex-none sm:min-w-[13rem]"
          >
            <option value="">All branches</option>
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
          <Select
            value={day}
            onChange={(e) => setDay(e.target.value)}
            ariaLabel="Day"
            className="flex-1 sm:flex-none"
          >
            <option value="">Any day</option>
            {DAYS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
          <Select
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            ariaLabel="From time"
            className="flex-1 sm:flex-none"
          >
            <option value="">Any time</option>
            {TIMES.map((t) => (
              <option key={t.value} value={t.value}>
                from {t.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {view === "list" ? (
        <GlobalList rows={sessionRows} now={now} nextPos={nextPos} />
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted">
          No gyms match{facetActive ? " that search" : ""}.
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,26rem),1fr))] gap-6">
          {shown.map((loc) => {
            // Open the class list when a day/time facet is set, or when a text
            // query matched one of this gym's classes (so the hit is visible).
            const showClasses =
              !!(dayFacet || fromTime) ||
              (tokens.length > 0 &&
                (loc.t?.schedule?.some(matchSessionIn(loc)) ?? false));
            return (
              <Card
                key={loc.handle}
                name={loc.name}
                handle={loc.handle}
                t={loc.t}
                defaultList={showClasses}
                matchSession={facetActive ? matchSessionIn(loc) : undefined}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

type Row = {
  gym: string;
  handle: string;
  post: string;
  s: ClassSession;
  pos: number;
};

// One global timeline across all gyms. Grouped Mon→Sun; the next upcoming class
// is accented. `now` is null until mount. Each row links to the gym's IG post.
function GlobalList({
  rows,
  now,
  nextPos,
}: {
  rows: Row[];
  now: number | null;
  nextPos: number;
}) {
  const todayIdx = now == null ? -1 : Math.floor(now / 1440);
  const byDay = DAYS.map((day, idx) => ({
    day,
    idx,
    rows: rows.filter((r) => r.s.day === day),
  })).filter((g) => g.rows.length);

  // Anchor = the latest class today that's already started (so opening the list
  // lands on "where we are now", not the top of the day). Falls back to today's
  // first class if nothing has started yet. rows are pre-sorted ascending.
  const todayRows =
    todayIdx >= 0 ? rows.filter((r) => r.s.day === DAYS[todayIdx]) : [];
  const anchorPos =
    now == null || !todayRows.length
      ? (todayRows[0]?.pos ?? -1)
      : (todayRows.filter((r) => r.pos <= now).at(-1)?.pos ?? todayRows[0].pos);

  // Live height of the sticky stack above the list (page header + filter
  // toolbar). The day label sticks right below it; heights differ on mobile
  // (taller, wrapped) vs desktop, and the toolbar can re-wrap, so measure +
  // watch for resize rather than hard-code a px offset.
  const [stackTop, setStackTop] = useState(56);
  useEffect(() => {
    const toolbar = document.querySelector<HTMLElement>("[data-toolbar]");
    const measure = () => {
      if (!toolbar) return;
      // Stick flush to the toolbar's pinned bottom. Use the toolbar's own sticky
      // offset (its `top-14`), NOT the header height — the header's bottom border
      // makes it 1px taller than where the toolbar actually pins, which otherwise
      // leaves a 1px sliver of list showing above the day label.
      const top = parseFloat(getComputedStyle(toolbar).top) || 0;
      setStackTop(top + toolbar.offsetHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (toolbar) ro.observe(toolbar);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  // Scroll the anchor into view on mount (switching into list view) and on day
  // rollover — NOT every minute, so the keys deliberately exclude anchorPos/now.
  const anchorRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    // Measure the live sticky stack (page header + filter toolbar) so the anchor
    // clears them — heights differ on mobile (taller, wrapped) vs desktop.
    const header = document.querySelector("header");
    const toolbar = document.querySelector<HTMLElement>("[data-toolbar]");
    const offset =
      (header?.offsetHeight ?? 0) + (toolbar?.offsetHeight ?? 0) + 8;
    const top = el.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top, behavior: "auto" });
  }, [todayIdx]);

  if (!byDay.length) {
    return <p className="text-sm text-muted">No classes match that search.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {byDay.map((g) => (
        <section key={g.day}>
          <h3
            style={{ top: stackTop }}
            className="sticky z-[5] -mx-1 mb-1.5 flex items-center gap-2 bg-canvas px-1 py-1.5 text-sm font-semibold tracking-tight text-ink"
          >
            {DAY_LABEL[g.day]}
            {g.idx === todayIdx && (
              <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-ink">
                Today
              </span>
            )}
          </h3>
          {/* One hairline-divided list, not a stack of bordered boxes — flatter
              and far more compact. Gym is the bold lead (this is a venue finder);
              class + instructor are the muted detail. */}
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {g.rows.map((r, n) => {
              const isNext = r.pos === nextPos;
              return (
                <li
                  key={`${r.handle}-${n}`}
                  ref={
                    g.idx === todayIdx && r.pos === anchorPos
                      ? anchorRef
                      : undefined
                  }
                >
                  <a
                    href={r.post}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`flex items-baseline gap-3 px-3 py-1.5 transition-colors ${
                      isNext ? "bg-accent-soft" : "hover:bg-surface-2"
                    }`}
                  >
                    <span
                      className={`w-16 shrink-0 font-mono text-xs font-semibold tabular-nums ${
                        isNext ? "text-accent-ink" : "text-ink"
                      }`}
                    >
                      {to12h(r.s.startTime)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink">
                        {titleCase(r.s.className)}
                        {r.s.instructor && (
                          <span className="ml-1 text-muted">
                            · {titleCase(r.s.instructor)}
                          </span>
                        )}
                      </span>
                      {/* Mobile: gym on its own line so it can't eat the class name. */}
                      <span className="mt-0.5 flex items-center gap-0.5 text-xs font-medium text-muted sm:hidden">
                        <span className="truncate">{r.gym}</span>
                        <ArrowUpRight
                          aria-hidden
                          className="h-3 w-3 shrink-0"
                        />
                      </span>
                    </span>
                    {/* Desktop: gym inline at the right. */}
                    <span className="hidden shrink-0 items-center gap-0.5 text-sm font-semibold text-ink sm:flex">
                      <span className="max-w-[16rem] truncate">{r.gym}</span>
                      <ArrowUpRight
                        aria-hidden
                        className="h-3.5 w-3.5 shrink-0 text-muted"
                      />
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
