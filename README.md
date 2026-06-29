# AF Calendar

Weekly group-exercise (GX) class timetables for Anytime Fitness gyms around the
Klang Valley, collected from each club's Instagram and shown in one grid — sorted
nearest-first to Kepong. Clubs post their schedule as an Instagram image (some
weekly, some monthly); this gathers them so you don't have to open 40 profiles.

## How it works

```
  weekly (Sun 22:30 MYT, launchd on your Mac)
  scripts/sync.ts ──Playwright scrape IG──▶ vision extract ──┐
                     (no LLM in the loop)   (AI gateway)     │ writes + mirrors
                                                             ▼   images to Blob
                                                        Redis cache
                                                             ▲
   page (SSR) ──reads──▶ Redis ──renders──▶ Card grid        │ overwrite on Retry
                                                             │
   Retry / force-refresh ──▶ /api/timetable ──Apify scrape──┘  (on-demand only)
```

Two ways data lands in Redis:

- **Weekly sync (primary).** [`scripts/sync.ts`](scripts/sync.ts) runs on your Mac
  via launchd. Playwright opens each gym's profile and reads the recent posts
  (carousel-aware, full-res images, skipping the suggested-post grid). The
  schedule post is chosen **caption-first** — a caption that names a schedule
  (keyword, a weekly date-range like "29 Jun - 5 Jul", or a month like "June
  2026") is OCR'd directly with `extractSchedule` (one cheap call, all of that
  post's carousel pages together). Only when the caption gives nothing does it
  fall back to the `classifyTimetable` vision step over the candidate covers.
  Results are written straight to Redis and images mirrored to Blob. No Apify,
  no browser-agent.
- **Apify, on-demand only.** A cache miss during normal browsing does **not**
  scrape — it serves cache (or the last confident entry). Apify
  (`apify/instagram-scraper`) runs **only** when you click **Retry** /
  force-refresh on a card. Set `USE_APIFY=0` to disable that path entirely.
- **`POST /api/ingest`** is the authenticated HTTP write path (Bearer
  `CRON_SECRET`) used to push externally-scraped timetables into the cache.

Storage details:

- **Upstash Redis** caches each result under `af-cal:tt:<YYYY-MM-DD>:<handle>`,
  where the date is the Monday that labels the week. Keys expire at the **Sunday
  22:00 MYT** rollover, so each week starts fresh. Successes live the whole week;
  errors are negative-cached ~6h.
- **Vercel Blob** mirrors timetable images at write time. Instagram's CDN URLs
  are signed and expire in ~4 days, so a week-long cache would break them; Blob
  copies are permanent. Without a Blob token, images fall back to live IG URLs via
  `/api/img` (and break after ~4 days).
- **First paint never blocks on a scrape** — SSR renders from cache only.

## Weekly sync (run it on your Mac)

The sync must run on your machine (it needs to reach Instagram, Upstash and the
AI gateway — none reachable from a CI/sandbox).

```bash
npm install
npx playwright install chromium
npm run sync            # scrape all gyms → write Redis (logs per gym + summary)
npm run sync -- af.ss2.petalingjaya   # sync only specific handle(s); rest untouched
```

Instagram usually allows logged-out scraping; if gyms come back empty, capture a
session once:

```bash
npm run sync:login      # opens a browser, log in, saves ig-session.json (gitignored)
npm run sync            # reuses the session
```

Schedule it weekly (Sunday 22:30, via macOS launchd):

```bash
npm run schedule:install     # load the launchd job
npm run schedule:run         # trigger a run now (test)
npm run schedule:uninstall   # remove it
tail -f sync.log             # watch runs
```

Keep your Mac on MYT so 22:30 lands after the cache rollover. If it's asleep at
22:30, launchd runs the job at the next wake.

## Setup (web app)

```bash
npm install
cp .env.example .env   # fill in the values below
npm run dev
```

Open <http://localhost:3000>.

### Environment

| Variable                                              | Required    | Purpose                                                                                                        |
| ----------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | yes         | Timetable cache. The sync writes here; the site reads here.                                                    |
| `AI_GATEWAY_API_KEY`                                  | yes         | Vision model (Gemini Flash Lite via Vercel AI Gateway) that classifies the timetable post and reads its grid. |
| `BLOB_READ_WRITE_TOKEN`                               | recommended | Mirrors images to Vercel Blob so they survive the week. Auto-set by the Vercel Blob integration.               |
| `CRON_SECRET`                                         | recommended | Bearer token guarding `POST /api/ingest`.                                                                      |
| `APIFY_TOKEN`                                         | optional    | On-demand **Retry**/force-refresh scraping only. Set `USE_APIFY=0` to disable.                                 |

Get tokens: [Apify](https://console.apify.com/account/integrations) ·
[Upstash](https://console.upstash.com/redis) ·
[Vercel Blob](https://vercel.com/dashboard/stores) ·
[AI Gateway](https://vercel.com/dashboard/ai-gateway).

## Editing the gym list

Locations live in [`lib/locations.ts`](lib/locations.ts) — `{ handle, name, lat,
lng }` per club. The grid sorts by distance to Kepong (`KEPONG` in the same
file). Add/remove entries there; the weekly sync reads this list.

## Cache admin

```bash
npm run flush                         # clear ALL cached timetables (every week/gym)
npm run flush -- af.ss2.petalingjaya  # clear one (or more) handles only
```

## Deploy

Deploy on [Vercel](https://vercel.com/new). Add the Upstash Redis, Vercel Blob,
and AI Gateway integrations (they inject the env vars), set `CRON_SECRET` (and
`APIFY_TOKEN` if you want on-demand Retry), and ship. The read-only filesystem is
fine — all state is in Redis and Blob. The weekly batch runs from your Mac, not
Vercel.

## Stack

Next.js (App Router) · React · Tailwind CSS · Upstash Redis · Vercel Blob ·
Vercel AI Gateway (Gemini) · Playwright · Apify (on-demand)
