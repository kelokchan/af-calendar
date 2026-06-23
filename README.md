# AF Calendar

Monthly class timetables for Anytime Fitness gyms around Klang Valley, scraped
from each club's Instagram and shown in one grid — sorted nearest-first to
Kepong. Most clubs post their group-exercise (GX) schedule as a pinned image
each month; this collects them so you don't have to open 40 Instagram profiles.

## How it works

```
page (SSR)  ──reads──▶  Redis cache  ◀──writes──  /api/timetable (per profile)
   │                        ▲                            │
   │ instant first paint    │ month-keyed               │ Apify scrape → pick
   ▼                        │                           ▼   schedule post
 each Card ──lazy fetch──▶ /api/timetable          Vercel Blob (mirror images)
 (on scroll, if uncached)                               │
                                                        ▼
                                          /api/img (proxy fallback, no Blob)
```

- **Apify** (`apify/instagram-scraper`) fetches a profile's recent posts. The
  schedule is chosen by preferring a **pinned** post whose caption looks like a
  timetable, falling back to keyword match, then any pinned post, then latest.
- **Upstash Redis** caches each result under `af-cal:tt:<YYYY-MM>:<handle>`,
  expiring at month end — so a profile is scraped at most once per month.
  Successes live the whole month; errors are negative-cached ~6h so a
  private/empty profile doesn't re-scrape on every load.
- **Vercel Blob** mirrors the schedule images at scrape time. Instagram's CDN
  URLs are signed and expire in ~4 days, so caching them a month would break
  every image mid-month; Blob copies are permanent.
- **First paint never blocks on a scrape** — SSR renders from cache only, and
  each card lazy-fetches its own profile when it scrolls into view. A cold month
  fills in card-by-card instead of one slow batch.

## Setup

```bash
npm install
cp .env.example .env   # fill in the values below
npm run dev
```

Open <http://localhost:3000>.

### Environment

| Variable                                              | Required    | Purpose                                                                                                                                                                                |
| ----------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APIFY_TOKEN`                                         | yes         | Instagram scraping via Apify. The only fetch path.                                                                                                                                     |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | on Vercel   | Timetable cache. Without it every request re-scrapes (fine for local dev).                                                                                                             |
| `BLOB_READ_WRITE_TOKEN`                               | recommended | Mirrors images to Vercel Blob so they survive the month. Auto-set by the Vercel Blob integration. Without it, images fall back to live IG URLs via `/api/img` and break after ~4 days. |

Get tokens: [Apify](https://console.apify.com/account/integrations) ·
[Upstash](https://console.upstash.com/redis) ·
[Vercel Blob](https://vercel.com/dashboard/stores).

## Editing the gym list

Locations live in [`lib/locations.ts`](lib/locations.ts) — `{ handle, name, lat,
lng }` per club. The grid sorts by distance to Kepong (`KEPONG` in the same
file). Add/remove entries there.

## Cache admin

Flush the current month (forces a clean re-scrape, e.g. after changing the
schedule-picking logic):

```bash
node -e 'const{Redis}=require("@upstash/redis");const fs=require("fs");for(const l of fs.readFileSync(".env","utf8").split("\n")){const m=l.match(/^([A-Z_]+)=(.*)$/);if(m)process.env[m[1]]=m[2].replace(/^["'\'']|["'\'']$/g,"")}const r=Redis.fromEnv();const mo=new Date().toISOString().slice(0,7);r.keys(`af-cal:tt:${mo}:*`).then(k=>k.length?r.del(...k):0).then(n=>console.log("flushed",n))'
```

## Deploy

Deploy on [Vercel](https://vercel.com/new). Add the Upstash Redis and Vercel
Blob integrations (they inject the env vars), set `APIFY_TOKEN`, and ship. The
read-only filesystem is fine — all state is in Redis and Blob.

## Stack

Next.js (App Router) · React · Tailwind CSS · Upstash Redis · Vercel Blob · Apify
