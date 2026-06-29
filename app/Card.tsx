"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCw } from "lucide-react";
import {
  to12h,
  titleCase,
  type Timetable,
  type ClassSession,
} from "@/lib/instagram";

const DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export default function Card({
  name,
  handle,
  t: initialT,
  matchSession,
}: {
  name: string;
  handle: string;
  t?: Timetable;
  matchSession?: (s: ClassSession) => boolean;
}) {
  // Cached server-side → render now. Otherwise fetch this one profile on mount,
  // so the grid fills card-by-card instead of blocking on a full batch scrape.
  const [t, setT] = useState<Timetable | undefined>(initialT);
  const [loading, setLoading] = useState(!initialT);
  const [forceOpen, setForceOpen] = useState(false);

  // Force restart appends force=1 (+ optional link/limit) so the server bypasses
  // the week cache and re-scrapes. User-driven (force dialog, retry); the
  // on-scroll auto-fetch never forces.
  const load = useCallback(
    (opts?: { force?: boolean; link?: string; limit?: number }) => {
      setLoading(true);
      const p = new URLSearchParams({ handle });
      if (opts?.force) p.set("force", "1");
      if (opts?.link) p.set("link", opts.link);
      if (opts?.limit) p.set("limit", String(opts.limit));
      return fetch(`/api/timetable?${p.toString()}`)
        .then((r) => r.json())
        .then((d: Timetable) => {
          setT(d);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    },
    [handle],
  );

  // Fetch only once the card scrolls near the viewport — staggers the scrape so
  // a cold month doesn't fire 42 Apify runs at once, and skips profiles never seen.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (initialT) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        io.disconnect();
        load();
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [initialT, load]);

  const schedule = t?.schedule ?? [];

  return (
    <div
      ref={ref}
      className="flex flex-col overflow-hidden rounded-2xl border border-line bg-surface transition-[border-color,box-shadow] duration-200 hover:border-accent hover:ring-1 hover:ring-accent"
    >
      <div className="flex h-[60px] items-center justify-between gap-2 px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold tracking-tight text-ink">
            {name}
          </h2>
          <a
            href={`https://instagram.com/${handle}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 font-mono text-[11px] text-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-accent-ink"
          >
            @{handle}
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-2.5 w-2.5 shrink-0"
              aria-hidden="true"
            >
              <path d="M7 17 17 7M9 7h8v8" />
            </svg>
          </a>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {loading ? (
            <span className="animate-pulse rounded-full bg-surface-2 px-2.5 py-0.5 text-[11px] font-medium text-muted">
              Loading
            </span>
          ) : t?.matchedMonth ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-0.5 text-[11px] font-medium text-accent-ink">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              Timetable
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => setForceOpen(true)}
            disabled={loading}
            title="Refresh — re-scrape (post link / count override)"
            aria-label="Refresh"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink transition-colors hover:border-ink/30 hover:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="relative h-80 w-full overflow-hidden border-y border-line bg-canvas">
        {loading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface-2">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-accent-soft border-t-accent" />
            <span className="animate-pulse text-xs text-muted">Loading…</span>
          </div>
        ) : schedule.length > 0 ? (
          <ScheduleList sessions={schedule} matchSession={matchSession} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <span className="text-sm text-muted">
              {t?.error ? "Couldn't load" : "No schedule found"}
            </span>
            {t?.error && (
              <span className="text-xs text-muted/70">{t.error}</span>
            )}
            <button
              type="button"
              onClick={() => load()}
              className="mt-1 rounded-lg bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-accent hover:text-white focus:outline-none focus:ring-2 focus:ring-accent/25"
            >
              Retry
            </button>
          </div>
        )}
      </div>

      {t?.postUrl ? (
        <a
          href={t.postUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-11 items-center justify-center gap-1.5 border-t border-line text-sm font-medium text-accent-ink transition-colors duration-150 hover:bg-accent-soft"
        >
          View on Instagram
          <span aria-hidden>→</span>
        </a>
      ) : (
        <div className="flex h-11 items-center justify-center border-t border-line text-sm font-medium text-muted">
          {loading ? "Loading…" : "No post"}
        </div>
      )}

      {forceOpen && (
        <ForceDialog
          handle={handle}
          onClose={() => setForceOpen(false)}
          onRun={(link, limit) => {
            setForceOpen(false);
            load({ force: true, link, limit });
          }}
        />
      )}
    </div>
  );
}

// Vision-parsed schedule, grouped Mon→Sun and sorted by start time. Rows that
// match the active class filter are highlighted so the gym's relevance is obvious.
function ScheduleList({
  sessions,
  matchSession,
}: {
  sessions: ClassSession[];
  matchSession?: (s: ClassSession) => boolean;
}) {
  const byDay = DAY_ORDER.map((day) => ({
    day,
    rows: sessions
      .filter((s) => s.day === day)
      .sort((a, b) => a.startTime.localeCompare(b.startTime)),
  })).filter((g) => g.rows.length);

  return (
    <div className="absolute inset-0 overflow-y-auto bg-canvas px-3 pb-3">
      {byDay.map((g) => (
        // No top padding on the scroll box: a sticky `top-0` label pins to the
        // content box (inset by padding), so a top pad leaves a band of rows
        // showing above the pinned label. Resting breathing room goes on the
        // first group only (first:pt-3) — it sits under the label when pinned.
        <div key={g.day} className="mb-3 first:pt-3 last:mb-0">
          <div className="sticky top-0 mb-1 bg-canvas pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
            {g.day}
          </div>
          <ul className="flex flex-col gap-0.5">
            {g.rows.map((s, n) => (
              <li
                key={n}
                className={`flex items-baseline gap-2 rounded-lg px-2 py-1 ${
                  matchSession?.(s)
                    ? "bg-accent-soft text-accent-ink"
                    : "bg-surface-2"
                }`}
              >
                <span className="w-14 shrink-0 font-mono text-[11px] font-semibold tabular-nums text-ink">
                  {to12h(s.startTime)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                  {titleCase(s.className)}
                  {s.instructor && (
                    <span className="ml-1 text-muted">
                      · {titleCase(s.instructor)}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// Force restart: re-scrape this profile, bypassing the month cache. Optional post
// link fetches that exact post (takes precedence); count overrides scrape depth.
function ForceDialog({
  handle,
  onClose,
  onRun,
}: {
  handle: string;
  onClose: () => void;
  onRun: (link?: string, limit?: number) => void;
}) {
  const [link, setLink] = useState("");
  const [count, setCount] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  const submit = () => {
    const l = link.trim();
    const n = parseInt(count, 10);
    onRun(l || undefined, Number.isFinite(n) && n > 0 ? n : undefined);
  };

  return createPortal(
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-xl"
      >
        <h3 className="mb-1 text-sm font-semibold tracking-tight text-ink">
          Force restart
        </h3>
        <p className="mb-4 text-xs text-muted">
          @{handle} — re-scrapes, bypassing this month&apos;s cache.
        </p>

        <label className="mb-1 block text-xs font-medium text-muted">
          Post link (optional)
        </label>
        <input
          autoFocus
          type="url"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="https://instagram.com/p/…"
          className="mb-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink placeholder:text-muted/60 transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
        />
        <p className="mb-4 text-xs text-muted/70">
          Takes precedence over count — fetches that exact post.
        </p>

        <label className="mb-1 block text-xs font-medium text-muted">
          Number of posts (default 12)
        </label>
        <input
          type="number"
          min={1}
          max={50}
          value={count}
          onChange={(e) => setCount(e.target.value)}
          placeholder="12"
          disabled={link.trim().length > 0}
          className="mb-5 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink placeholder:text-muted/60 transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-40"
        />

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-ink focus:outline-none focus:ring-2 focus:ring-accent/25"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            className="rounded-lg bg-accent px-3.5 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-accent/40"
          >
            Run
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

