"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { List, ImageIcon, RefreshCw } from "lucide-react";
import {
  to12h,
  titleCase,
  type Timetable,
  type ClassSession,
} from "@/lib/instagram";

const DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

// takenAt is unix seconds → "3 Jun 2026". null when no post / not scraped yet.
const fmtDate = (s: number) =>
  new Date(s * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

const proxied = (u: string) => `/api/img?u=${encodeURIComponent(u)}`;
// IG CDN urls can't be hotlinked → route via proxy; Blob/other urls load direct.
const src = (u: string) =>
  /cdninstagram\.com|fbcdn\.net/.test(u) ? proxied(u) : u;

export default function Card({
  name,
  handle,
  t: initialT,
  defaultList = false,
  matchSession,
}: {
  name: string;
  handle: string;
  t?: Timetable;
  // A class filter is active → open straight to the list. matchSession highlights
  // the rows that matched, so it's obvious why this gym is in the results.
  defaultList?: boolean;
  matchSession?: (s: ClassSession) => boolean;
}) {
  // Cached server-side → render now. Otherwise fetch this one profile on mount,
  // so the grid fills card-by-card instead of blocking on a full batch scrape.
  const [t, setT] = useState<Timetable | undefined>(initialT);
  const [loading, setLoading] = useState(!initialT);
  const [i, setI] = useState(0); // default to first slide
  const [open, setOpen] = useState(false);
  const [forceOpen, setForceOpen] = useState(false);
  const [cardImageLoading, setCardImageLoading] = useState(true);
  const [listView, setListView] = useState(defaultList);
  // Re-sync with the global filter when it flips — React's "adjust state on prop
  // change" pattern (during render, not an effect), so the per-card toggle stays
  // free to override in between.
  const [prevDefault, setPrevDefault] = useState(defaultList);
  if (defaultList !== prevDefault) {
    setPrevDefault(defaultList);
    setListView(defaultList);
  }

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
          setI(d.images.length > 1 ? 1 : 0);
          setCardImageLoading(true);
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

  const images = t?.images ?? [];
  const schedule = t?.schedule ?? [];
  const caption = t?.caption?.trim() ?? "";
  const showList = listView && schedule.length > 0;
  const idx = Math.min(i, Math.max(0, images.length - 1));
  const prev = () => {
    setCardImageLoading(true);
    setI((n) => (n - 1 + images.length) % images.length);
  };
  const next = () => {
    setCardImageLoading(true);
    setI((n) => (n + 1) % images.length);
  };

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
          ) : (
            images.length > 0 && (
              <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-[11px] font-medium text-muted">
                Latest
              </span>
            )
          )}
          {schedule.length > 0 && (
            <button
              type="button"
              onClick={() => setListView((v) => !v)}
              title={showList ? "Show timetable image" : "Show class list"}
              aria-label={showList ? "Show timetable image" : "Show class list"}
              aria-pressed={showList}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-white transition-colors hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-accent/40"
            >
              {showList ? (
                <ImageIcon className="h-4 w-4" />
              ) : (
                <List className="h-4 w-4" />
              )}
            </button>
          )}
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

      <div className="group relative aspect-square w-full overflow-hidden border-y border-line bg-canvas">
        {showList ? (
          <ScheduleList sessions={schedule} matchSession={matchSession} />
        ) : images.length ? (
          <>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="block h-full w-full cursor-zoom-in"
              aria-label="Open image"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src(images[idx])}
                alt={`${name} timetable ${idx + 1}`}
                loading="lazy"
                // cached imgs are already complete before onLoad attaches → fire manually, else spinner sticks
                ref={(el) => {
                  if (el?.complete) setCardImageLoading(false);
                }}
                onLoad={() => setCardImageLoading(false)}
                onError={() => setCardImageLoading(false)}
                className="h-full w-full object-contain"
              />
            </button>
            {loading && (
              <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-canvas/75 backdrop-blur-[2px]">
                <div className="h-12 w-12 animate-spin rounded-full border-4 border-accent-soft border-t-accent" />
                <span className="animate-pulse rounded-full bg-surface px-3 py-1 text-[11px] font-medium text-accent-ink shadow-sm">
                  Re-scraping…
                </span>
              </div>
            )}
            {cardImageLoading && !loading && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-canvas/50 backdrop-blur-[1px] transition-opacity duration-150">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-accent-soft border-t-accent" />
              </div>
            )}
            {images.length > 1 && (
              <>
                <Arrow side="left" onClick={prev} />
                <Arrow side="right" onClick={next} />
              </>
            )}
            {(images.length > 1 || caption) && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 bg-gradient-to-t from-black/75 via-black/45 to-transparent px-3 pb-3 pt-10">
                {images.length > 1 && (
                  <div className="flex gap-1.5">
                    {images.map((_, n) => (
                      <span
                        key={n}
                        className={`h-1.5 rounded-full transition-all duration-200 ${
                          n === idx ? "w-5 bg-white" : "w-1.5 bg-white/50"
                        }`}
                      />
                    ))}
                  </div>
                )}
                {caption && (
                  <p className="line-clamp-2 w-full whitespace-pre-line text-center text-[11px] leading-snug text-white/90">
                    {caption}
                  </p>
                )}
              </div>
            )}
          </>
        ) : loading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface-2">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-accent-soft border-t-accent" />
            <span className="animate-pulse text-xs text-muted">Loading…</span>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <span className="text-sm text-muted">
              {t?.error ? "Couldn't load" : "No post found"}
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

      {t?.takenAt && (
        <div className="flex h-9 items-center gap-1.5 border-t border-line px-4 text-xs text-muted">
          <span className="font-medium text-ink">Posted</span>
          {fmtDate(t.takenAt)}
        </div>
      )}

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

      {open && (
        <Lightbox
          images={images}
          index={idx}
          name={name}
          caption={caption}
          postUrl={t?.postUrl ?? null}
          onPrev={prev}
          onNext={next}
          onClose={() => setOpen(false)}
        />
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

function Arrow({
  side,
  onClick,
}: {
  side: "left" | "right";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === "left" ? "Previous" : "Next"}
      className={`absolute top-1/2 -mt-[18px] ${
        side === "left" ? "left-2" : "right-2"
      } flex h-9 w-9 items-center justify-center rounded-full bg-surface/90 pb-0.5 text-xl leading-none text-ink opacity-0 shadow-sm backdrop-blur transition-all duration-150 hover:bg-surface focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 group-hover:opacity-100`}
    >
      {side === "left" ? "‹" : "›"}
    </button>
  );
}

function Lightbox({
  images,
  index,
  name,
  caption,
  postUrl,
  onPrev,
  onNext,
  onClose,
}: {
  images: string[];
  index: number;
  name: string;
  caption: string;
  postUrl: string | null;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const [imgLoading, setImgLoading] = useState(true);

  const handlePrev = useCallback(() => {
    setImgLoading(true);
    onPrev();
  }, [onPrev]);

  const handleNext = useCallback(() => {
    setImgLoading(true);
    onNext();
  }, [onNext]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") handlePrev();
      else if (e.key === "ArrowRight") handleNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, handlePrev, handleNext]);

  const touchX = useRef<number | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    // single finger only — a 2nd finger (pinch-zoom) nulls this so the swipe doesn't change slides
    touchX.current = e.touches.length === 1 ? e.touches[0].clientX : null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchX.current;
    touchX.current = null;
    if (Math.abs(dx) > 50) (dx < 0 ? handleNext : handlePrev)();
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      onClick={onClose}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
    >
      <div className="absolute left-4 top-4 flex items-center gap-3 text-sm font-medium text-white/90">
        <span>
          {name}
          {images.length > 1 && (
            <span className="ml-2 text-white/50">
              {index + 1}/{images.length}
            </span>
          )}
        </span>
        {postUrl && (
          <a
            href={postUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white backdrop-blur transition-colors hover:bg-white/20"
          >
            View post ↗
          </a>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 pb-1 text-2xl leading-none text-white backdrop-blur transition-colors hover:bg-white/20"
      >
        ×
      </button>
      {images.length > 1 && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handlePrev();
            }}
            aria-label="Previous"
            className="absolute left-2 top-1/2 -mt-7 flex h-14 w-14 items-center justify-center rounded-full bg-white/10 pb-1 text-4xl text-white backdrop-blur transition-colors hover:bg-white/20 sm:left-6"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleNext();
            }}
            aria-label="Next"
            className="absolute right-2 top-1/2 -mt-7 flex h-14 w-14 items-center justify-center rounded-full bg-white/10 pb-1 text-4xl text-white backdrop-blur transition-colors hover:bg-white/20 sm:right-6"
          >
            ›
          </button>
        </>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src(images[index])}
        alt={`${name} timetable ${index + 1}`}
        // cached imgs are already complete before onLoad attaches → fire manually, else spinner sticks
        ref={(el) => {
          if (el?.complete) setImgLoading(false);
        }}
        onLoad={() => setImgLoading(false)}
        onError={() => setImgLoading(false)}
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
      />
      {imgLoading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30 backdrop-blur-[2px] transition-opacity duration-150">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-white/20 border-t-white" />
        </div>
      )}
      {caption && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute inset-x-0 bottom-0 max-h-[30%] overflow-y-auto bg-gradient-to-t from-black/90 to-transparent px-4 pb-5 pt-12"
        >
          <p className="mx-auto max-w-2xl whitespace-pre-line text-center text-sm leading-relaxed text-white/90">
            {caption}
          </p>
        </div>
      )}
    </div>,
    document.body,
  );
}
