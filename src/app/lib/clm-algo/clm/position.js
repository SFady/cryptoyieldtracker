import { ALGO_CONFIG, REDIS_KEYS } from '../config.js';
import { readLpState } from '../../cronKv.js';

// Module 3 — État de la position CLM + décision de rebalance

/**
 * Lit ou dérive l'état de la position LP depuis Redis / DB.
 * Calcule la neutral zone autour du midpoint.
 */
export async function getPositionState(kv) {
  // Priorité : état sauvegardé par le bot
  let state = await kv.get(REDIS_KEYS.POSITION_STATE);
  if (state) return state;

  // Fallback : construire depuis l'état LP existant
  const lpState = await readLpState(ALGO_CONFIG.POOL_NUM);
  if (!lpState || lpState.action2 !== null) return null;

  const lowerPrice = parseFloat(lpState.range_min);
  const upperPrice = parseFloat(lpState.range_max);
  if (isNaN(lowerPrice) || isNaN(upperPrice)) return null;

  const midPrice       = Math.sqrt(lowerPrice * upperPrice);
  const neutralZoneLow  = midPrice * (1 - ALGO_CONFIG.NEUTRAL_ZONE_PCT);
  const neutralZoneHigh = midPrice * (1 + ALGO_CONFIG.NEUTRAL_ZONE_PCT);

  state = { lowerPrice, upperPrice, midPrice, neutralZoneLow, neutralZoneHigh };
  await kv.set(REDIS_KEYS.POSITION_STATE, state, { ex: 86400 });
  return state;
}

/**
 * Sauvegarde un nouvel état de position après rebalance.
 */
export async function savePositionState(kv, { lowerPrice, upperPrice }) {
  const midPrice        = Math.sqrt(lowerPrice * upperPrice);
  const neutralZoneLow  = midPrice * (1 - ALGO_CONFIG.NEUTRAL_ZONE_PCT);
  const neutralZoneHigh = midPrice * (1 + ALGO_CONFIG.NEUTRAL_ZONE_PCT);
  const state = { lowerPrice, upperPrice, midPrice, neutralZoneLow, neutralZoneHigh };
  await kv.set(REDIS_KEYS.POSITION_STATE, state, { ex: 86400 });
  return state;
}

/**
 * Détermine la zone dans laquelle se trouve le prix.
 * @returns { zone: "oor_lower"|"oor_upper"|"below_neutral"|"above_neutral"|"neutral", pctFromMid }
 */
export function evaluateZone(currentPrice, positionState) {
  const { lowerPrice, upperPrice, midPrice, neutralZoneLow, neutralZoneHigh } = positionState;
  const pctFromMid = (currentPrice - midPrice) / midPrice;

  if (currentPrice < lowerPrice)  return { zone: 'oor_lower',     pctFromMid };
  if (currentPrice > upperPrice)  return { zone: 'oor_upper',     pctFromMid };
  if (currentPrice < neutralZoneLow)  return { zone: 'below_neutral', pctFromMid };
  if (currentPrice > neutralZoneHigh) return { zone: 'above_neutral', pctFromMid };
  return { zone: 'neutral', pctFromMid };
}

/**
 * Vérifie si un rebalance est nécessaire basé sur la durée hors range.
 * @returns { shouldRebalance: bool, bias: "lower"|"upper"|null, minSince: number|null }
 */
export async function evaluateRebalance(kv, zone) {
  const isOOR = zone === 'oor_lower' || zone === 'oor_upper';

  if (!isOOR) {
    await kv.del(REDIS_KEYS.OOR_SINCE);
    return { shouldRebalance: false, bias: null, minSince: null };
  }

  const bias = zone === 'oor_lower' ? 'lower' : 'upper';
  let oorSince = await kv.get(REDIS_KEYS.OOR_SINCE);
  if (!oorSince) {
    oorSince = Date.now();
    await kv.set(REDIS_KEYS.OOR_SINCE, oorSince, { ex: 7200 });
  }

  const minSince = (Date.now() - oorSince) / 60000;
  const shouldRebalance = minSince >= ALGO_CONFIG.REBALANCE_DELAY_MIN;
  return { shouldRebalance, bias, minSince: Math.round(minSince) };
}
