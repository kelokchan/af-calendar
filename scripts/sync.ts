/**
 * Local weekly timetable sync — no Apify, no browser-agent.
 *
 * Runs on YOUR machine (which, unlike the Cowork sandbox, can reach Instagram,
 * Upstash and the AI gateway directly). Playwright handles the deterministic
 * part (open each gym's IG profile → grab recent posts' image URLs + caption +
 * date) with NO LLM in the loop, then hands the posts to the app's existing
 * vision pipeline (classify + extractSchedule) and writes straight to Redis via
 * syncTimetableFromPosts. Vision (the cheap grid parse) is the only AI step.
 *
 * Run:   npm run sync           (loads .env, scrapes all gyms, writes Redis)
 * Env:   UPSTASH_REDIS_REST_URL/TOKEN, AI_GATEWAY_API_KEY, BLOB_READ_WRITE_TOKEN
 *        must be in .env (they already are). Pass --env-file=.env (npm script does).
 *
 * Login: defaults to LOGGED-OUT scraping. If Instagram walls it (missing posts),
 *        create a session once:  npm run sync:login   (opens a browser, you log
 *        in, it saves ig-session.json) — the sync then reuses that session.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { LOCATIONS } from "../lib/locations";
import {
  syncTimetableFromPosts,
  captionLikelyTimetable,
  type Post,
} from "../lib/instagram";

// Timestamped logger so sync.log lines are self-dating across weekly runs.
const ts = () => new Date().toLocaleTimeString("en-GB", { hour12: false });
const log = (msg: string) => console.log(`${ts()} ${msg}`);
const snippet = (s: string, n = 40) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};
const fmtDate = (unix: number | null) =>
  unix ? new Date(unix * 1000).toISOString().slice(0, 10) : "no-date";

const SESSION_FILE = path.join(process.cwd(), "ig-session.json");
const POSTS_PER_PROFILE = 12; // some gyms bury the timetable under promos + pinned posts (e.g. SS2), so read deeper
const CONCURRENCY = 2; // parallel profiles — keep low so IG doesn't rate-limit/wall
const NAV_TIMEOUT = 30_000;

// Small concurrency pool: run `fn` over items, at most `limit` at a time.
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

const isPostMedia = (u: string) =>
  /^https?:\/\//.test(u) &&
  /(cdninstagram\.com|fbcdn\.net)/.test(u) &&
  !/s150x150|s320x320|profile_pic|150x150/.test(u); // drop avatars/thumbnails

// Collect up to POSTS_PER_PROFILE recent post permalinks from a profile page.
async function postLinks(
  ctx: BrowserContext,
  handle: string,
): Promise<string[]> {
  const page = await ctx.newPage();
  try {
    await page.goto(`https://www.instagram.com/${handle}/`, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    // Grab EVERY anchor's href and filter in JS (robust to IG's grid markup),
    // scrolling a few times since the grid lazy-mounts after load.
    let hrefs: string[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      hrefs = await page.$$eval("a", (as) =>
        as.map((a) => (a as HTMLAnchorElement).href).filter(Boolean),
      );
      // Only image posts (/p/) — timetables are never reels/IGTV, and skipping
      // them avoids wasting candidate slots on promo reels pinned to the top.
      if (hrefs.some((h) => /\/p\//.test(h))) break;
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(1800);
    }
    if (!hrefs.some((h) => /\/(p|reel|tv)\//.test(h))) {
      // Diagnose what IG actually rendered. Dump landing url/title, a sample of
      // the hrefs we DID find, and counts for a few candidate post selectors so
      // we can pin the right one. Screenshot saved alongside.
      const title = await page.title().catch(() => "?");
      const probe = await page
        .evaluate(() => ({
          anchors: document.querySelectorAll("a").length,
          withP: document.querySelectorAll("a[href*='/p/']").length,
          roleLinks: document.querySelectorAll("[role='link']").length,
          imgsInMain: document.querySelectorAll("main img").length,
          sampleHrefs: Array.from(document.querySelectorAll("a"))
            .map((a) => (a as HTMLAnchorElement).getAttribute("href"))
            .filter(Boolean)
            .slice(0, 12),
        }))
        .catch(() => null);
      console.log(`    [debug] ${handle}: url=${page.url()} title="${title}"`);
      console.log(`    [debug] ${handle}: ${JSON.stringify(probe)}`);
      await page
        .screenshot({ path: `scripts/debug-${handle}.png` })
        .catch(() => {});
    }
    const seen = new Set<string>();
    const uniq: string[] = [];
    for (const h of hrefs) {
      const m = h.match(/\/p\/[^/]+\//);
      if (!m) continue;
      const clean = `https://www.instagram.com${m[0]}`;
      if (!seen.has(clean)) {
        seen.add(clean);
        uniq.push(clean);
      }
      if (uniq.length >= POSTS_PER_PROFILE) break;
    }
    return uniq;
  } finally {
    await page.close();
  }
}

// Read the large image(s) currently mounted in the post's media region. Scopes
// to the carousel (multi-image) or, for a single-image post, the FIRST large
// image only — so the "more posts"/suggested grid below is never collected.
function readVisibleImages(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const best = (img: HTMLImageElement): { url: string; w: number } => {
      const ss = img.getAttribute("srcset");
      if (ss) {
        let url = "";
        let w = -1;
        for (const part of ss.split(",")) {
          const [u, ww] = part.trim().split(/\s+/);
          const width = parseInt(ww || "0", 10);
          if (u && width > w) {
            w = width;
            url = u;
          }
        }
        if (url) return { url, w };
      }
      return { url: img.currentSrc || img.src, w: img.naturalWidth || 0 };
    };
    const root = document.querySelector("article") || document.body;
    const carousel = root.querySelector('[aria-roledescription="carousel"]');
    const scope: Element = carousel || root;
    const single = !carousel;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const el of Array.from(scope.querySelectorAll("img"))) {
      const { url, w } = best(el as HTMLImageElement);
      if (!url || w < 500) continue;
      if (/profile_pic|s150x150|s320x320/.test(url)) continue;
      if (!seen.has(url)) {
        seen.add(url);
        out.push(url);
      }
      if (single) break; // single post: just the post image, skip the suggested grid
    }
    return out;
  });
}

// Collect ALL carousel slide images by clicking "Next" through the post — IG
// only mounts the visible slide, so a single read sees just page 1. Walks until
// the Next button disappears (last slide) or a safety cap, unioning each step.
async function collectPostImages(page: Page): Promise<string[]> {
  const all = new Set<string>();
  for (let i = 0; i < 12; i++) {
    for (const u of await readVisibleImages(page)) all.add(u);
    const next = await page.$('button[aria-label="Next"], [aria-label="Next"]');
    if (!next) break; // single image, or reached the last slide
    const box = await next.boundingBox().catch(() => null);
    if (!box) break;
    await next.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(650); // let the next slide mount/load
  }
  return [...all];
}

// Read one post: full-res image(s) (carousel-aware), caption, date.
async function readPost(
  ctx: BrowserContext,
  url: string,
): Promise<Post | null> {
  const page = await ctx.newPage();
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    await page.waitForTimeout(1500);
    const meta = await page.evaluate(() => {
      const m = (p: string) =>
        document
          .querySelector(`meta[property="${p}"]`)
          ?.getAttribute("content") ?? "";
      const dt =
        document.querySelector("time[datetime]")?.getAttribute("datetime") ??
        null;
      return { ogImage: m("og:image"), ogDesc: m("og:description"), dt };
    });
    const postImgs = await collectPostImages(page);
    // Fall back to og:image only if no post media was found (og:image is IG's
    // center-cropped 1:1 share preview, so it slices wide timetables).
    const raw = postImgs.length ? postImgs : [meta.ogImage];
    const uniqImages = [...new Set(raw.filter(isPostMedia))].slice(0, 10);
    if (!uniqImages.length) {
      console.log(
        `    [debug] no media ${url}: og="${(meta.ogImage || "").slice(0, 50)}"`,
      );
      return null;
    }
    // og:description is usually `<likes> likes … - <user> on <date>: "<caption>"`.
    const capMatch = meta.ogDesc.match(/:\s*"([\s\S]*)"\s*$/);
    const caption = (capMatch ? capMatch[1] : meta.ogDesc).trim();
    return {
      caption,
      images: uniqImages,
      url,
      takenAt: meta.dt ? Math.floor(Date.parse(meta.dt) / 1000) : null,
      pinned: false, // pinned detection is unreliable logged-out; classifier drives the pick
    };
  } catch (e) {
    console.log(
      `    [debug] readPost error ${url}: ${e instanceof Error ? e.message : e}`,
    );
    return null;
  } finally {
    await page.close();
  }
}

async function scrapeHandle(
  ctx: BrowserContext,
  handle: string,
): Promise<{ posts: Post[]; links: number }> {
  const links = await postLinks(ctx, handle);
  const posts: Post[] = [];
  for (const link of links) {
    const p = await readPost(ctx, link);
    if (p) {
      posts.push(p);
      // Early stop: caption-first means once we hit a post whose caption names a
      // schedule, that's almost certainly the timetable — no need to keep loading
      // the rest of the profile (fewer requests = far less IG rate-limiting).
      if (captionLikelyTimetable(p.caption)) break;
    }
    await new Promise((r) => setTimeout(r, 400)); // gentle pacing between post loads
  }
  if (!posts.length && links.length)
    console.log(
      `    [debug] ${handle}: ${links.length} links but all posts unreadable`,
    );
  return { posts, links: links.length };
}

async function main() {
  const login = process.argv.includes("--login");
  // IG sometimes serves a login/consent wall to headless browsers. Set HEADFUL=1
  // to run with a visible window (also useful for debugging "no posts found").
  const headful = login || process.env.HEADFUL === "1";
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: !headful });

    if (login) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto("https://www.instagram.com/accounts/login/");
      console.log(
        "\n>>> Log into Instagram in the opened window. After your feed loads, press ENTER here.",
      );
      await new Promise<void>((res) => process.stdin.once("data", () => res()));
      await ctx.storageState({ path: SESSION_FILE });
      console.log(`Saved session to ${SESSION_FILE}`);
      await browser.close();
      return;
    }

    const hasSession = existsSync(SESSION_FILE);
    const ctx = await browser.newContext({
      storageState: hasSession ? SESSION_FILE : undefined,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      viewport: { width: 1280, height: 1600 },
    });
    // tsx/esbuild ("keep names") wraps our in-page functions with a __name()
    // helper that doesn't exist in the browser, so every page.evaluate would
    // throw "__name is not defined". Define it in every page (passed as a STRING
    // so esbuild doesn't instrument this line too and recreate the problem).
    await ctx.addInitScript("window.__name = (fn) => fn;");

    // Optional handle filter: `npm run sync -- <handle> [<handle>...]` syncs only
    // those gyms (the rest stay as-is). No args → all gyms.
    const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
    const targets = only.length
      ? LOCATIONS.filter((l) => only.includes(l.handle))
      : LOCATIONS;
    if (only.length && !targets.length) {
      log(`no gyms match: ${only.join(", ")}`);
      return;
    }

    const runStart = Date.now();
    log(
      `Sync start — ${targets.length}${only.length ? `/${LOCATIONS.length}` : ""} gyms · session: ${hasSession ? "yes" : "logged-out"} · headless: ${!headful} · concurrency: ${CONCURRENCY}`,
    );

    type Status = "ok" | "no-posts" | "no-tt" | "carried" | "fail";
    const results: {
      handle: string;
      status: Status;
      detail: string;
      secs: string;
    }[] = [];
    let done = 0;

    await mapLimit(targets, CONCURRENCY, async (loc) => {
      const started = Date.now();
      const tag = `(${++done}/${targets.length})`;
      const finish = () => ((Date.now() - started) / 1000).toFixed(1);
      try {
        const { posts, links } = await scrapeHandle(ctx, loc.handle);
        if (!posts.length) {
          await syncTimetableFromPosts(loc.handle, []); // negative-cache
          const secs = finish();
          results.push({
            handle: loc.handle,
            status: "no-posts",
            detail: `${links} links, 0 readable`,
            secs,
          });
          log(`${tag} [no-posts] ${loc.handle} · ${links} links · ${secs}s`);
          return;
        }
        const t = await syncTimetableFromPosts(loc.handle, posts);
        const secs = finish();
        if (t.schedule?.length) {
          // Did vision land on a fresh post, or did we carry a prior entry?
          const carried = !posts.some((p) => p.url === t.postUrl);
          const status: Status = carried ? "carried" : "ok";
          const detail = `${t.schedule.length} sessions · ${t.images.length} img · "${snippet(t.caption)}" · ${fmtDate(t.takenAt)}`;
          results.push({ handle: loc.handle, status, detail, secs });
          log(
            `${tag} [${carried ? "carried" : "ok"}] ${loc.handle} · ${detail} · ${secs}s`,
          );
        } else {
          results.push({
            handle: loc.handle,
            status: "no-tt",
            detail: `${posts.length} posts read, no timetable parsed`,
            secs,
          });
          log(
            `${tag} [no-tt] ${loc.handle} · ${posts.length} posts, none parsed as a timetable · ${secs}s`,
          );
        }
      } catch (e) {
        const secs = finish();
        const detail = e instanceof Error ? e.message : String(e);
        results.push({ handle: loc.handle, status: "fail", detail, secs });
        log(`${tag} [FAIL] ${loc.handle} · ${detail} · ${secs}s`);
      }
    });

    // ---- Summary ----
    const by = (s: Status) => results.filter((r) => r.status === s);
    const mins = ((Date.now() - runStart) / 1000 / 60).toFixed(1);
    log("──────── summary ────────");
    log(
      `ok=${by("ok").length} carried=${by("carried").length} no-tt=${by("no-tt").length} no-posts=${by("no-posts").length} fail=${by("fail").length} · ${mins} min`,
    );
    log(
      `with a timetable: ${by("ok").length + by("carried").length}/${targets.length}`,
    );
    const attention = results.filter((r) => r.status !== "ok");
    if (attention.length) {
      log(`needs attention (${attention.length}):`);
      for (const r of attention)
        log(`   - [${r.status}] ${r.handle}: ${r.detail}`);
    }
    log(`done in ${mins} min`);

    // Bust the homepage's 1h ISR cache so this run shows immediately instead of
    // after the next revalidation. Fire-and-forget; skips if SITE_URL is unset.
    const site = process.env.SITE_URL;
    if (site) {
      try {
        const r = await fetch(`${site}/api/revalidate`, {
          method: "POST",
          headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
        });
        log(`revalidate ${site}: ${r.status}`);
      } catch (e) {
        log(`revalidate failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  } finally {
    await browser?.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
