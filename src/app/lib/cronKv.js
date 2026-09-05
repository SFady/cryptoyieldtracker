import { kv } from "@vercel/kv";

const KEY          = "weth-history";
const KEY_LAST_RUN = "cron-last-run";
const TTL_MS       = 24 * 60 * 60 * 1000;
const LP_STATE_TTL = 604800; // 7 jours en secondes

// Parse member : nouveau format "timestamp:price" ou ancien format "price"
function parsePriceMember(member) {
  const s = String(member);
  const colon = s.indexOf(':');
  return Number(colon !== -1 ? s.slice(colon + 1) : s);
}

export async function writeCronPrice(price) {
  const now = Date.now();
  await kv.zadd(KEY, { score: now, member: `${now}:${price}` });
  await kv.zremrangebyscore(KEY, 0, now - TTL_MS);
  await kv.set(KEY_LAST_RUN, now);
}

// N derniers prix CRON (scores les plus hauts = timestamps les plus récents)
export async function getLastNPrices(n) {
  try {
    const entries = await kv.zrange(KEY, 0, n - 1, { rev: true });
    return entries.map(parsePriceMember).filter(v => v > 0);
  } catch (_) { return []; }
}

// 3 derniers prix CRON (scores les plus hauts = timestamps les plus récents)
export async function getLastTwoPrices() {
  try {
    const entries = await kv.zrange(KEY, 0, 2, { rev: true });
    return entries.map(parsePriceMember).filter(v => v > 0);
  } catch (_) { return []; }
}

// Percentiles p05/p95 pondérés exponentiellement (half-life 8h)
const HALF_LIFE_MS = 8 * 60 * 60 * 1000;
const DECAY        = Math.LN2 / HALF_LIFE_MS;

export async function getPercentileRange() {
  try {
    const entries = await kv.zrange(KEY, 0, -1);
    if (entries.length < 10) return null;
    const now = Date.now();
    const weighted = entries.map(m => {
      const s     = String(m);
      const colon = s.indexOf(':');
      const price  = colon !== -1 ? Number(s.slice(colon + 1)) : Number(s);
      const ts     = colon !== -1 ? Number(s.slice(0, colon))  : null;
      const age    = ts ? now - ts : HALF_LIFE_MS * 3;
      return { price, weight: Math.exp(-DECAY * age) };
    }).filter(({ price }) => price > 100 && price < 100000);
    if (weighted.length < 10) return null;
    weighted.sort((a, b) => a.price - b.price);
    const totalW = weighted.reduce((s, { weight }) => s + weight, 0);
    let cum = 0, p05 = null, p95 = null;
    for (const { price, weight } of weighted) {
      cum += weight;
      const frac = cum / totalW;
      if (p05 === null && frac >= 0.05) p05 = price;
      if (p95 === null && frac >= 0.95) { p95 = price; break; }
    }
    if (!p05 || !p95) return null;
    return { p05, p95, cnt: weighted.length };
  } catch (_) { return null; }
}

// Prochain cron = dernier run + 5 min
export async function getNextCronAt() {
  try {
    const lastRun = await kv.get(KEY_LAST_RUN);
    if (!lastRun) return null;
    const next = new Date(Number(lastRun) + 5 * 60 * 1000);
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

export async function clearLpState(poolNum) {
  try { await kv.del(`lp-state-${poolNum}`); } catch (_) {}
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

// Lock distribué (remplace lp_events RUNNING) — TTL 5 min géré par Redis
export async function checkRedisLock() {
  try { return !!(await kv.get("lp-running")); } catch (_) { return false; }
}

export async function acquireRedisLock() {
  const lockId = `LOCK_${Date.now()}`;
  try {
    const ok = await kv.set("lp-running", lockId, { nx: true, ex: 300 });
    if (!ok) return null;
    return async () => { try { await kv.del("lp-running"); } catch (_) {} };
  } catch (_) { return null; }
}

// Swap WETH→USDC en attente (fees non swappées après échec slippage)
export async function writeWethFeesPending(poolNum, pct) {
  try { await kv.set(`weth-fees-pending-${poolNum}`, pct, { ex: LP_STATE_TTL }); } catch (_) {}
}
export async function readWethFeesPending(poolNum) {
  try { return await kv.get(`weth-fees-pending-${poolNum}`); } catch (_) { return null; }
}
export async function clearWethFeesPending(poolNum) {
  try { await kv.del(`weth-fees-pending-${poolNum}`); } catch (_) {}
}

// Range réel de la position pool 2 (long-lived, mis à jour à chaque chargement positions2)
export async function writeP2Range(min, max, entry = null) {
  try { await kv.set('p2_live_range', { min: String(min), max: String(max), ...(entry !== null && { entry: String(entry) }) }, { ex: LP_STATE_TTL }); } catch (_) {}
}
export async function readP2Range() {
  try { return await kv.get('p2_live_range'); } catch (_) { return null; }
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

// Cache des données positions (60 s — évite les requêtes SQL Neon à chaque chargement de page)
export async function readPositionsCache(poolNum) {
  try { return await kv.get(`positions-cache-${poolNum}`); } catch (_) { return null; }
}
export async function writePositionsCache(poolNum, data) {
  try { await kv.set(`positions-cache-${poolNum}`, data, { ex: 15 }); } catch (_) {}
}

// Bank de fees journalières (5%/30 par jour vers DESTINATION_WALLET)
export async function readFeesBank() {
  try { return parseFloat((await kv.get('p2_fees_bank')) ?? 0) || 0; } catch (_) { return 0; }
}
export async function writeFeesBank(amount) {
  try { await kv.set('p2_fees_bank', amount, { ex: LP_STATE_TTL }); } catch (_) {}
}
export async function readLastDailyTx() {
  try { return await kv.get('p2_last_daily_tx'); } catch (_) { return null; }
}
export async function writeLastDailyTx(date) {
  try { await kv.set('p2_last_daily_tx', date, { ex: LP_STATE_TTL }); } catch (_) {}
}

// Ancre de prix 7 jours (signal de tendance haussier/baissier, TTL 8j auto-reset)
export async function writePriceAnchor7d(price) {
  try { await kv.set('p2_price_anchor_7d', price, { ex: 8 * 86400 }); } catch (_) {}
}
export async function readPriceAnchor7d() {
  try { return await kv.get('p2_price_anchor_7d'); } catch (_) { return null; }
}
