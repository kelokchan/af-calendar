/**
 * Flush cached timetables from Redis. Forces a clean re-sync (e.g. after changing
 * the pick/extract logic, or to clear stale/contaminated image entries).
 *
 *   npm run flush          # delete ALL af-cal:tt:* keys (every week, every gym)
 *   npm run flush -- <h>   # delete only keys for handle(s), e.g. npm run flush -- af.ss2.petalingjaya
 *
 * Reads UPSTASH_REDIS_REST_URL/TOKEN from .env (loaded via --env-file).
 */
import { Redis } from "@upstash/redis";

async function main() {
  const redis = Redis.fromEnv();
  const handles = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const pattern = handles.length ? null : "af-cal:tt:*";

  let keys: string[] = [];
  if (pattern) {
    keys = await redis.keys(pattern);
  } else {
    for (const h of handles) keys.push(...(await redis.keys(`af-cal:tt:*:${h}`)));
  }

  if (!keys.length) {
    console.log("nothing to flush");
    return;
  }
  await redis.del(...keys);
  console.log(`flushed ${keys.length} key(s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
