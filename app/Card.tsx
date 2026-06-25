"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Timetable } from "@/lib/instagram";

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
}: {
  name: string;
  handle: string;
  t?: Timetable;
}) {
  // Cached server-side → render now. Otherwise fetch this one profile on mount,
  // so the grid fills card-by-card instead of blocking on a full batch scrape.
  const [t, setT] = useState<Timetable | undefined>(initialT);
  const [loading, setLoading] = useState(!initialT);
  const [i, setI] = useState(0); // default to first slide
  const [open, setOpen] = useState(false);
  const [forceOpen, setForceOpen] = useState(false);
  const [cardImageLoading, setCardImageLoading] = useState(true);

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
  const caption = t?.caption?.trim() ?? "";
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
      className="nb-pop flex flex-col overflow-hidden rounded-lg bg-surface"
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
            <span className="animate-pulse rounded-md border-2 border-line bg-surface px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-muted">
              loading
            </span>
          ) : t?.matchedMonth ? (
            <span className="inline-flex items-center gap-1 rounded-md border-2 border-line bg-accent px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-white">
              <span className="h-1.5 w-1.5 rounded-full bg-white" />
              timetable
            </span>
          ) : (
            images.length > 0 && (
              <span className="rounded-md border-2 border-line bg-surface px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-ink">
                latest
              </span>
            )
          )}
          <button
            type="button"
            onClick={() => setForceOpen(true)}
            disabled={loading}
            title="Force re-scrape (post link / count override)"
            aria-label="Force restart"
            className="inline-flex items-center gap-1 rounded-md border-2 border-line bg-surface px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-muted shadow-[2px_2px_0_0_var(--shadow)] transition-all hover:bg-accent hover:text-white active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:cursor-not-allowed disabled:opacity-50"
          >
            ⟳ Force
          </button>
        </div>
      </div>

      <div className="group relative aspect-[4/5] w-full overflow-hidden border-y-2 border-line bg-canvas">
        {images.length ? (
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
                <span className="animate-pulse rounded-md border-2 border-line bg-surface px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-wide text-accent-ink shadow-[2px_2px_0_0_var(--shadow)]">
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
                        className={`h-2 border border-white/80 transition-all duration-200 ${
                          n === idx ? "w-5 bg-accent" : "w-2 bg-white/60"
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
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-line/30">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-accent-soft border-t-accent" />
            <span className="animate-pulse font-mono text-[11px] font-bold uppercase tracking-wide text-muted">
              Loading…
            </span>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <span className="font-mono text-xs text-muted">
              {t?.error ? "Couldn't load" : "No post found"}
            </span>
            {t?.error && (
              <span className="font-mono text-[10px] text-muted/70">
                {t.error}
              </span>
            )}
            <button
              type="button"
              onClick={() => load()}
              className="mt-1 rounded-md border-2 border-line bg-surface px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-wide text-ink shadow-[2px_2px_0_0_var(--shadow)] transition-all hover:bg-accent hover:text-white active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
            >
              Retry
            </button>
          </div>
        )}
      </div>

      {t?.takenAt && (
        <div className="flex h-8 items-center gap-1.5 border-t-2 border-line px-4 font-mono text-[10px] uppercase tracking-wide text-muted">
          <span className="font-bold">Posted</span>
          {fmtDate(t.takenAt)}
        </div>
      )}

      {t?.postUrl ? (
        <a
          href={t.postUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-11 items-center justify-center gap-1.5 border-t-2 border-line text-xs font-bold uppercase tracking-wide text-ink transition-colors duration-150 hover:bg-accent hover:text-white"
        >
          View on Instagram
          <span aria-hidden>→</span>
        </a>
      ) : (
        <div className="flex h-11 items-center justify-center border-t-2 border-line text-xs font-bold uppercase tracking-wide text-muted">
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
        className="w-full max-w-sm rounded-lg border-2 border-line bg-surface p-5 shadow-[6px_6px_0_0_var(--shadow)]"
      >
        <h3 className="mb-1 text-sm font-semibold tracking-tight text-ink">
          Force restart
        </h3>
        <p className="mb-4 font-mono text-[11px] text-muted">
          @{handle} — re-scrapes, bypassing this month&apos;s cache.
        </p>

        <label className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-wide text-muted">
          Post link (optional)
        </label>
        <input
          autoFocus
          type="url"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="https://instagram.com/p/…"
          className="mb-1 w-full rounded-md border-2 border-line bg-canvas px-3 py-2 text-sm text-ink shadow-[2px_2px_0_0_var(--shadow)] placeholder:text-muted/60 focus:shadow-[3px_3px_0_0_var(--accent)] focus:outline-none"
        />
        <p className="mb-4 font-mono text-[10px] text-muted/70">
          Takes precedence over count — fetches that exact post.
        </p>

        <label className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-wide text-muted">
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
          className="mb-5 w-full rounded-md border-2 border-line bg-canvas px-3 py-2 text-sm text-ink shadow-[2px_2px_0_0_var(--shadow)] placeholder:text-muted/60 focus:shadow-[3px_3px_0_0_var(--accent)] focus:outline-none disabled:opacity-40"
        />

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border-2 border-line bg-surface px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wide text-ink shadow-[2px_2px_0_0_var(--shadow)] transition-all hover:bg-canvas active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            className="rounded-md border-2 border-line bg-accent px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wide text-white shadow-[2px_2px_0_0_var(--shadow)] transition-all hover:opacity-90 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
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
      } flex h-9 w-9 items-center justify-center rounded-md border-2 border-line bg-surface pb-0.5 text-xl leading-none text-ink opacity-0 shadow-[3px_3px_0_0_var(--shadow)] transition-all duration-150 hover:bg-accent hover:text-white focus-visible:opacity-100 active:translate-x-[3px] active:translate-y-[3px] active:shadow-none group-hover:opacity-100`}
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
            className="rounded-md border-2 border-white bg-white/10 px-3 py-1 text-xs font-bold uppercase tracking-wide shadow-[2px_2px_0_0_rgba(255,255,255,0.7)] transition-colors hover:bg-accent"
          >
            View post ↗
          </a>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-md border-2 border-white bg-white/10 pb-1 text-2xl leading-none text-white shadow-[3px_3px_0_0_rgba(255,255,255,0.7)] transition-all hover:bg-accent active:translate-x-[3px] active:translate-y-[3px] active:shadow-none"
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
            className="absolute left-2 top-1/2 -mt-7 flex h-14 w-14 items-center justify-center rounded-md border-2 border-white bg-white/10 pb-1 text-4xl text-white shadow-[4px_4px_0_0_rgba(255,255,255,0.7)] transition-all hover:bg-accent active:translate-x-[3px] active:translate-y-[3px] active:shadow-none sm:left-6"
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
            className="absolute right-2 top-1/2 -mt-7 flex h-14 w-14 items-center justify-center rounded-md border-2 border-white bg-white/10 pb-1 text-4xl text-white shadow-[4px_4px_0_0_rgba(255,255,255,0.7)] transition-all hover:bg-accent active:translate-x-[3px] active:translate-y-[3px] active:shadow-none sm:right-6"
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
        className="max-h-full max-w-full rounded-lg border-2 border-white object-contain shadow-[8px_8px_0_0_rgba(255,255,255,0.5)]"
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
