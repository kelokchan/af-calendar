import { NextRequest } from "next/server";
import { ingestTimetables, type ClassSession, type Timetable } from "@/lib/instagram";

// Manual ingest endpoint. The weekly browser task (Sunday noon MYT) scrapes each
// gym's Instagram page, parses the timetable, then POSTs the results here. This
// replaces the Apify scrape path: schedules land directly in this week's Redis
// cache and the site renders them unchanged.
//
// Auth: same CRON_SECRET fail-closed scheme as /api/cron — unset/mismatched
// secret keeps the endpoint locked so nobody can poison the cache.
//
// Body: { "entries": Timetable[] }. Each entry needs at least `handle`; a real
// `schedule` array makes it a confident timetable (week-long TTL). Missing
// `matchedMonth` defaults to true (the task only sends posts it identified as
// timetables); set it false to write a soft/empty entry.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Trust-but-verify: the task is authenticated, but still coerce each row so a
// malformed payload can't write garbage shapes the UI chokes on.
function cleanSchedule(raw: unknown): ClassSession[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ClassSession[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const s = r as Record<string, unknown>;
    const day = String(s.day ?? "");
    const startTime = String(s.startTime ?? "");
    const className = String(s.className ?? "").trim();
    if (!DAYS.includes(day) || !/^\d{2}:\d{2}$/.test(startTime) || !className)
      continue;
    out.push({
      day: day as ClassSession["day"],
      startTime,
      className,
      instructor:
        typeof s.instructor === "string" && s.instructor.trim()
          ? s.instructor.trim()
          : undefined,
    });
  }
  return out.length ? out : undefined;
}

function cleanEntry(raw: unknown): Timetable | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.handle !== "string" || !e.handle) return null;
  const schedule = cleanSchedule(e.schedule);
  return {
    handle: e.handle,
    // Raw IG image URLs from the scrape; ingestTimetables mirrors them to Blob.
    images: Array.isArray(e.images)
      ? (e.images.filter(
          (u) => typeof u === "string" && /^https?:\/\//.test(u),
        ) as string[])
      : [],
    caption: typeof e.caption === "string" ? e.caption : "",
    postUrl: typeof e.postUrl === "string" ? e.postUrl : null,
    takenAt: typeof e.takenAt === "number" ? e.takenAt : null,
    // Default true: the task only forwards posts it judged to be timetables.
    matchedMonth: e.matchedMonth !== false,
    schedule,
  };
}

export async function POST(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`)
    return Response.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const rawEntries = (body as { entries?: unknown })?.entries;
  if (!Array.isArray(rawEntries) || !rawEntries.length)
    return Response.json({ error: "no entries" }, { status: 400 });

  const entries = rawEntries
    .map(cleanEntry)
    .filter((e): e is Timetable => e !== null);
  if (!entries.length)
    return Response.json({ error: "no valid entries" }, { status: 400 });

  await ingestTimetables(entries);
  return Response.json({
    ok: true,
    written: entries.length,
    handles: entries.map((e) => e.handle),
  });
}
