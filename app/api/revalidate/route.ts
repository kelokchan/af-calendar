import { revalidatePath } from "next/cache";

// The homepage is ISR (`revalidate = 3600`), so after the Mac sync writes fresh
// timetables to Redis the site keeps serving the pre-sync render for up to an
// hour. scripts/sync.ts POSTs here at the end of a run to bust that cache so the
// new schedule shows immediately. Reuses CRON_SECRET (same fail-closed Bearer
// check as /api/cron) — no new env to provision.
export async function POST(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`)
    return new Response("Unauthorized", { status: 401 });
  revalidatePath("/");
  return Response.json({ revalidated: true });
}
