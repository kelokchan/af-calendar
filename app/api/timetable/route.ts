import { NextRequest } from "next/server";
import { fetchTimetable } from "@/lib/instagram";

// Per-profile fetch so the grid fills in card-by-card instead of blocking SSR
// on one big batch scrape. Cache hit → instant; miss → scrape just this handle.
// Force restart params: force=1 bypasses cache; link=<IG post url> scrapes that
// exact post (precedence); limit=<n> overrides scrape depth.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const handle = sp.get("handle");
  if (!handle)
    return Response.json({ error: "missing handle" }, { status: 400 });

  const link = sp.get("link")?.trim() || undefined;
  // Only accept Instagram post URLs as a scrape target — this drives an Apify run.
  if (link && !/^https?:\/\/(www\.)?instagram\.com\/(p|reel|tv)\//.test(link))
    return Response.json({ error: "invalid link" }, { status: 400 });

  // Clamp depth 1..50 so a fat limit can't run up the Apify bill.
  const n = Number(sp.get("limit"));
  const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 50) : undefined;

  return Response.json(
    await fetchTimetable(handle, {
      force: sp.get("force") === "1",
      postUrl: link,
      limit,
    }),
  );
}
