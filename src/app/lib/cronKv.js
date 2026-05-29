import { kv } from "@vercel/kv";

const KEY          = "weth-history";
const KEY_LAST_RUN = "cron-last-run";
const TTL_MS       = 24 * 60 * 60 * 1000;

export async function writeCronPrice(price) {
  const now = Date.now();
  await kv.zadd(KEY, { score: now, member: String(price) });
  await kv.zremrangebyscore(KEY, 0, now - TTL_MS);
  await kv.set(KEY_LAST_RUN, now);
}

// 2 derniers prix (scores les plus hauts = timestamps les plus récents)
export async function getLastTwoPrices() {
  try {
    const entries = await kv.zrange(KEY, 0, 1, { rev: true });
    return entries.map(Number).filter(n => n > 0);
  } catch (_) { return []; }
}

// Percentiles p05/p95 sur les 24 dernières heures
export async function getPercentileRange() {
  try {
    const now     = Date.now();
    const entries = await kv.zrange(KEY, now - TTL_MS, now, { byScore: true });
    if (entries.length < 10) return null;
    const sorted = entries.map(Number).sort((a, b) => a - b);
    const p05    = sorted[Math.floor(sorted.length * 0.05)];
    const p95    = sorted[Math.floor(sorted.length * 0.95)];
    return { p05, p95, cnt: sorted.length };
  } catch (_) { return null; }
}

// Prochain cron = dernier run + 30 min
export async function getNextCronAt() {
  try {
    const lastRun = await kv.get(KEY_LAST_RUN);
    if (!lastRun) return null;
    const next = new Date(Number(lastRun) + 30 * 60 * 1000);
    return next.toISOString();
  } catch (_) { return null; }
}
