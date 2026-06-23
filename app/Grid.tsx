"use client";

import { useState } from "react";
import Card from "./Card";
import type { Timetable } from "@/lib/instagram";

type Item = { name: string; handle: string; t?: Timetable };

export default function Grid({ items }: { items: Item[] }) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? items.filter(
        (it) =>
          it.name.toLowerCase().includes(needle) ||
          it.handle.toLowerCase().includes(needle),
      )
    : items;

  return (
    <>
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search gyms…"
        className="mb-6 w-full max-w-sm rounded-md border-2 border-line bg-surface px-3 py-2 text-sm font-medium text-ink shadow-[3px_3px_0_0_var(--shadow)] transition-shadow placeholder:font-normal placeholder:text-muted focus:shadow-[5px_5px_0_0_var(--accent)] focus:outline-none"
      />
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
