// Module 8 — Logs et métriques du bot CLM
import { neon } from '@neondatabase/serverless';

const METRICS_KEY = 'p2_algo_metrics';

async function writeToDB(tickData) {
  if (!process.env.DATABASE_URL) return;
  try {
    const sql = neon(process.env.DATABASE_URL);

    const price      = tickData.price      ?? null;
    const action     = tickData.action     ?? null;
    const hasLp      = tickData.hasLP      ?? null;
    const hasShort   = tickData.hasShort   ?? null;
    const isOor      = tickData.isOOR      ?? null;
    const rangeMin   = tickData.rMin       ?? null;
    const rangeMax   = tickData.rMax       ?? null;
    const bucket     = tickData.bucket     ?? null;
    const poolNum    = tickData.poolNum    ?? 2;

    // Hedge adjust
    const ha          = tickData.hedgeAdjust ?? null;
    const wethInPool  = ha?.wethInPool  ?? tickData.wethInPool ?? null;
    const shortSize   = ha?.currentShortEth ?? null;
    const shortTarget = ha?.targetEth       ?? null;
    const shortDelta  = ha?.delta           ?? null;

    // Auto-start (direct ou via collect)
    const as        = tickData.autoStart ?? tickData.collect?.autoStart ?? null;
    const capital   = as?.capital    ?? null;
    const ethAtOpen = as?.ethAtOpen  ?? null;
    const shortEntry= as?.shortEntry ?? null;

    // Collect : USDC récupéré = wallet USDC+WETH après fermeture LP
    const closeLP   = tickData.collect?.closeLP ?? null;
    const usdcRec   = closeLP?.finalUsdcRaw ?? null;

    await sql`
      INSERT INTO bot_ticks
        (ts, pool_num, price, action, has_lp, has_short, is_oor,
         range_min, range_max, bucket,
         weth_in_pool, short_size, short_target, short_delta,
         capital, eth_at_open, short_entry, usdc_recovered, details)
      VALUES
        (NOW(), ${poolNum}, ${price}, ${action}, ${hasLp}, ${hasShort}, ${isOor},
         ${rangeMin}, ${rangeMax}, ${bucket},
         ${wethInPool}, ${shortSize}, ${shortTarget}, ${shortDelta},
         ${capital}, ${ethAtOpen}, ${shortEntry}, ${usdcRec}, ${JSON.stringify(tickData)})
    `;
  } catch (_) {}
}

/**
 * Enregistre un tick dans Redis (rolling 50) + Neon DB (permanent).
 */
export async function logBotTick(kv, tickData) {
  try {
    const existing = (await kv.get(METRICS_KEY)) ?? [];
    const updated  = [{ ts: new Date().toISOString(), ...tickData }, ...existing].slice(0, 50);
    await kv.set(METRICS_KEY, updated, { ex: 7 * 86400 });
  } catch (_) {}
  console.log('[clm-algo]', JSON.stringify(tickData));

  await writeToDB(tickData);
}

/**
 * Lit les métriques Redis (pour affichage UI).
 */
export async function getBotMetrics(kv) {
  return (await kv.get(METRICS_KEY)) ?? [];
}
