"use client";

import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";

// Show after one viewport of scroll; tap to jump back up.
export default function ScrollTop() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > window.innerHeight);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!show) return null;
  return (
    <button
      type="button"
      aria-label="Scroll to top"
      onClick={() => window.scrollTo({ top: 0, behavior: "instant" })}
      className="fixed bottom-5 right-5 z-30 inline-flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface text-ink shadow-lg transition-colors hover:bg-surface-2"
    >
      <ArrowUp className="h-5 w-5" />
    </button>
  );
}
