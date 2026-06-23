'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Timetable } from '@/lib/instagram';

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
  const [i, setI] = useState((initialT?.images.length ?? 0) > 1 ? 1 : 0); // carousel cover often a banner; 2nd usually the schedule
  const [open, setOpen] = useState(false);
  const [cardImageLoading, setCardImageLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    return fetch(`/api/timetable?handle=${encodeURIComponent(handle)}`)
      .then((r) => r.json())
      .then((d: Timetable) => {
        setT(d);
        setI(d.images.length > 1 ? 1 : 0);
        setCardImageLoading(true);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [handle]);

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
      { rootMargin: '300px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [initialT, load]);

  const images = t?.images ?? [];
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
      className="nb-pop group/card flex flex-col overflow-hidden rounded-lg bg-surface">
      <div className="flex h-[60px] items-center justify-between gap-2 px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold tracking-tight text-ink">
            {name}
          </h2>
          <a
            href={`https://instagram.com/${handle}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[11px] text-muted transition-colors hover:text-accent-ink">
            @{handle}
          </a>
        </div>
        {loading ? (
          <span className="shrink-0 animate-pulse rounded-md border-2 border-line bg-surface px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-muted shadow-[2px_2px_0_0_var(--shadow)]">
            loading
          </span>
        ) : t?.matchedMonth ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-md border-2 border-line bg-accent px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-white shadow-[2px_2px_0_0_var(--shadow)]">
            <span className="h-1.5 w-1.5 rounded-full bg-white" />
            timetable
          </span>
        ) : (
          images.length > 0 && (
            <span className="shrink-0 rounded-md border-2 border-line bg-surface px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-ink shadow-[2px_2px_0_0_var(--shadow)]">
              latest
            </span>
          )
        )}
      </div>

      <div className="group relative aspect-[4/5] w-full overflow-hidden border-y-2 border-line bg-canvas">
        {images.length ? (
          <>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="block h-full w-full cursor-zoom-in"
              aria-label="Open image">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src(images[idx])}
                alt={`${name} timetable ${idx + 1}`}
                loading="lazy"
                onLoad={() => setCardImageLoading(false)}
                onError={() => setCardImageLoading(false)}
                className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover/card:scale-[1.02]"
              />
            </button>
            {cardImageLoading && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-canvas/50 backdrop-blur-[1px] transition-opacity duration-150">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-accent-soft border-t-accent" />
              </div>
            )}
            {images.length > 1 && (
              <>
                <Arrow side="left" onClick={prev} />
                <Arrow side="right" onClick={next} />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-black/45 to-transparent pb-3 pt-8">
                  <div className="flex gap-1.5">
                    {images.map((_, n) => (
                      <span
                        key={n}
                        className={`h-2 border border-white/80 transition-all duration-200 ${
                          n === idx ? 'w-5 bg-accent' : 'w-2 bg-white/60'
                        }`}
                      />
                    ))}
                  </div>
                </div>
              </>
            )}
          </>
        ) : loading ? (
          <div className="h-full w-full animate-pulse bg-line/40" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <span className="font-mono text-xs text-muted">
              {t?.error ? "Couldn't load" : 'No post found'}
            </span>
            {t?.error && (
              <span className="font-mono text-[10px] text-muted/70">
                {t.error}
              </span>
            )}
            <button
              type="button"
              onClick={() => load()}
              className="mt-1 rounded-md border-2 border-line bg-surface px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-wide text-ink shadow-[2px_2px_0_0_var(--shadow)] transition-all hover:bg-accent hover:text-white active:translate-x-[2px] active:translate-y-[2px] active:shadow-none">
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
          className="flex h-11 items-center justify-center gap-1.5 border-t-2 border-line text-xs font-bold uppercase tracking-wide text-ink transition-colors duration-150 hover:bg-accent hover:text-white">
          View on Instagram
          <span
            aria-hidden
            className="transition-transform duration-200 group-hover/card:translate-x-1">
            →
          </span>
        </a>
      ) : (
        <div className="flex h-11 items-center justify-center border-t-2 border-line text-xs font-bold uppercase tracking-wide text-muted">
          {loading ? 'Loading…' : 'No post'}
        </div>
      )}

      {open && (
        <Lightbox
          images={images}
          index={idx}
          name={name}
          postUrl={t?.postUrl ?? null}
          onPrev={prev}
          onNext={next}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function Arrow({
  side,
  onClick,
}: {
  side: 'left' | 'right';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === 'left' ? 'Previous' : 'Next'}
      className={`absolute top-1/2 -mt-[18px] ${
        side === 'left' ? 'left-2' : 'right-2'
      } flex h-9 w-9 items-center justify-center rounded-md border-2 border-line bg-surface pb-0.5 text-xl leading-none text-ink opacity-0 shadow-[3px_3px_0_0_var(--shadow)] transition-all duration-150 hover:bg-accent hover:text-white focus-visible:opacity-100 active:translate-x-[3px] active:translate-y-[3px] active:shadow-none group-hover:opacity-100`}>
      {side === 'left' ? '‹' : '›'}
    </button>
  );
}

function Lightbox({
  images,
  index,
  name,
  postUrl,
  onPrev,
  onNext,
  onClose,
}: {
  images: string[];
  index: number;
  name: string;
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
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') handlePrev();
      else if (e.key === 'ArrowRight') handleNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, handlePrev, handleNext]);

  const touchX = useRef<number | null>(null);
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchX.current;
    touchX.current = null;
    if (Math.abs(dx) > 50) (dx < 0 ? handleNext : handlePrev)();
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      onClick={onClose}
      onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
      onTouchEnd={onTouchEnd}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4">
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
            className="rounded-md border-2 border-white bg-white/10 px-3 py-1 text-xs font-bold uppercase tracking-wide shadow-[2px_2px_0_0_rgba(255,255,255,0.7)] transition-colors hover:bg-accent">
            View post ↗
          </a>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-md border-2 border-white bg-white/10 pb-1 text-2xl leading-none text-white shadow-[3px_3px_0_0_rgba(255,255,255,0.7)] transition-all hover:bg-accent active:translate-x-[3px] active:translate-y-[3px] active:shadow-none">
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
            className="absolute left-2 top-1/2 -mt-7 flex h-14 w-14 items-center justify-center rounded-md border-2 border-white bg-white/10 pb-1 text-4xl text-white shadow-[4px_4px_0_0_rgba(255,255,255,0.7)] transition-all hover:bg-accent active:translate-x-[3px] active:translate-y-[3px] active:shadow-none sm:left-6">
            ‹
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleNext();
            }}
            aria-label="Next"
            className="absolute right-2 top-1/2 -mt-7 flex h-14 w-14 items-center justify-center rounded-md border-2 border-white bg-white/10 pb-1 text-4xl text-white shadow-[4px_4px_0_0_rgba(255,255,255,0.7)] transition-all hover:bg-accent active:translate-x-[3px] active:translate-y-[3px] active:shadow-none sm:right-6">
            ›
          </button>
        </>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src(images[index])}
        alt={`${name} timetable ${index + 1}`}
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
    </div>,
    document.body,
  );
}
