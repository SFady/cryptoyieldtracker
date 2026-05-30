import { kv } from "@vercel/kv";

const KEY          = "weth-history";
const KEY_LAST_RUN = "cron-last-run";
const TTL_MS       = 24 * 60 * 60 * 1000;
const LP_STATE_TTL = 86400; // 24h en secondes

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

// État de la dernière position ouverte (CREATE_OK) par pool
export async function writeLpState(poolNum, data) {
  try { await kv.set(`lp-state-${poolNum}`, data, { ex: LP_STATE_TTL }); } catch (_) {}
}

export async function readLpState(poolNum) {
  try { return await kv.get(`lp-state-${poolNum}`); } catch (_) { return null; }
}

// Flag "fees collectées aujourd'hui" par pool (date Paris)
export async function writeCollectedToday(poolNum) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
  try { await kv.set(`fee-today-${poolNum}-${today}`, 1, { ex: LP_STATE_TTL }); } catch (_) {}
}

export async function wasCollectedToday(poolNum) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
  try { return !!(await kv.get(`fee-today-${poolNum}-${today}`)); } catch (_) { return false; }
}

// État d'erreur lp_events (CREATE_ERR / CLOSE_ERR)
export async function writeErrorState(poolNum, hasError, msg = null) {
  try { await kv.set(`lp-err-${poolNum}`, { hasError, msg }, { ex: LP_STATE_TTL }); } catch (_) {}
}

export async function readErrorState(poolNum) {
  try { return await kv.get(`lp-err-${poolNum}`); } catch (_) { return null; }
}

// État COLLECT_ERR du dernier FEE_COLLECT
export async function writeCollectErr(poolNum, isError) {
  try { await kv.set(`fee-err-${poolNum}`, isError ? 1 : 0, { ex: LP_STATE_TTL }); } catch (_) {}
}

export async function readCollectErr(poolNum) {
  try { const v = await kv.get(`fee-err-${poolNum}`); return v === null ? null : !!v; } catch (_) { return null; }
}
