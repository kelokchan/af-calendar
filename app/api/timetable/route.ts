import { NextRequest } from "next/server";
import { fetchTimetable } from "@/lib/instagram";

// Per-profile fetch so the grid fills in card-by-card instead of blocking SSR
// on one big batch scrape. Cache hit → instant; miss → scrape just this handle.
export async function GET(req: NextRequest) {
  const handle = req.nextUrl.searchParams.get("handle");
  if (!handle)
    return Response.json({ error: "missing handle" }, { status: 400 });
  // ?refresh=1 → bypass the month cache and re-scrape (gym posted a new
  // schedule mid-month). User-driven only, so the extra Apify cost is bounded.
  const force = req.nextUrl.searchParams.get("refresh") === "1";
  return Response.json(await fetchTimetable(handle, force));
}
