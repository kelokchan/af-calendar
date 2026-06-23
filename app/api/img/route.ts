import { NextRequest } from "next/server";
import { cdnUrl } from "@/lib/instagram";

// Proxy IG CDN images — the browser can't hotlink them directly (403/blocked),
// but our server can fetch and stream them.
// ponytail: host allowlist keeps this from being an open proxy. Add hosts if IG
// serves images from a new CDN domain.
const ALLOWED = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/;

export async function GET(req: NextRequest) {
  const u = req.nextUrl.searchParams.get("u");
  if (!u) return new Response("missing u", { status: 400 });

  let target: URL;
  try {
    // Normalize region-local hosts (fna/scontent-<pop>) to the global CDN, else
    // the server can't reach them — works for URLs cached before normalization.
    target = new URL(cdnUrl(u));
  } catch {
    return new Response("bad url", { status: 400 });
  }
  if (!ALLOWED.test(target.hostname)) {
    return new Response("host not allowed", { status: 403 });
  }

  // IG CDN resets bursts of datacenter requests — retry a couple times before
  // giving up so a transient reset doesn't surface as a broken image.
  let res: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(target, {
        headers: {
          "user-agent": "Mozilla/5.0",
          referer: "https://www.instagram.com/",
        },
        next: { revalidate: 86400 },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) break;
    } catch {
      // network reset/timeout — fall through to retry
    }
  }
  if (!res?.ok) return new Response("upstream error", { status: 502 });

  return new Response(res.body, {
    headers: {
      "content-type": res.headers.get("content-type") ?? "image/jpeg",
      "cache-control": "public, max-age=86400",
    },
  });
}
