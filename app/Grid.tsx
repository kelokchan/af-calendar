"use client";

import { useEffect, useState } from "react";
import Card from "./Card";
import type { Timetable } from "@/lib/instagram";

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

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? ranked.filter(
        (it) =>
          it.name.toLowerCase().includes(needle) ||
          it.handle.toLowerCase().includes(needle),
      )
    : ranked;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search gyms…"
          className="w-full max-w-sm rounded-md border-2 border-line bg-surface px-3 py-2 text-sm font-medium text-ink shadow-[3px_3px_0_0_var(--shadow)] transition-shadow placeholder:font-normal placeholder:text-muted focus:shadow-[5px_5px_0_0_var(--accent)] focus:outline-none"
        />
        <span className="inline-flex items-center gap-1.5 rounded-md border-2 border-line bg-surface px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wide text-muted shadow-[2px_2px_0_0_var(--shadow)]">
          <span
            aria-hidden
            className={`h-1.5 w-1.5 rounded-full ${origin ? "bg-accent" : "bg-muted/50"}`}
          />
          {origin ? "Nearest you" : "Nearest Kepong"}
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,26rem),1fr))] gap-6">
        {shown.map((loc) => (
          <Card
            key={loc.handle}
            name={loc.name}
            handle={loc.handle}
            t={loc.t}
          />
        ))}
      </div>
    </>
  );
}
