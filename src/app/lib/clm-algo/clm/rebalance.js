import { ALGO_CONFIG, REDIS_KEYS } from '../config.js';
import { savePositionState } from './position.js';
import { closeShort } from '../hedge/hyperliquid.js';

// Module 4 — Rebalance CLM + remise en range avec biais

// targetRatio par biais :
//   "lower" → 80% WETH (prix revenu après passage sous range)
//   "upper" → 20% WETH (prix revenu après passage au-dessus du range)
//   "neutral" → 50% WETH (repositionnement standard)
const RATIO_BY_BIAS = { lower: 0.8, upper: 0.2, neutral: 0.5 };

/**
 * Ferme la LP + short existants, réouvre avec biais.
 * @param {Object} p
 * @param {string} p.base        APP_URL (ex: "https://...")
 * @param {number} p.currentPrice
 * @param {"lower"|"upper"|"neutral"} p.bias
 * @param {Object} p.runtimeConfig  { capital, leverage, shortSizeEth }
 * @param {Object} p.kv          Vercel KV instance
 */
export async function rebalanceCLMPosition({ base, currentPrice, bias, runtimeConfig, positionState, kv }) {
  const { capital, leverage, shortSizeEth, rangePct } = runtimeConfig;
  const targetRatio = RATIO_BY_BIAS[bias] ?? 0.5;

  // Préserver le range original (stocké au Start). Fallback sur les bornes actuelles de la LP.
  let halfRange;
  if (rangePct) {
    halfRange = rangePct / 200; // rangePct est en %, divisé par 2 pour chaque côté, puis /100
  } else if (positionState) {
    halfRange = Math.sqrt(positionState.upperPrice / positionState.lowerPrice) - 1;
  } else {
    halfRange = ALGO_CONFIG.RANGE_PCT;
  }

  // Bornes symétriques passées à createPosition (il recalcule selon targetRatio)
  const minPrice = currentPrice * (1 - halfRange);
  const maxPrice = currentPrice * (1 + halfRange);

  const steps = {};

  // 1. Fermer le short HL si ouvert
  try {
    const closeResult = await closeShort(base);
    steps.closeShort = closeResult;
  } catch (e) {
    steps.closeShort = { error: e.message };
  }

  // 2. Fermer la LP (noTransfer=true : fonds restent dans le wallet LP)
  let closedCapital = capital;
  try {
    const res = await fetch(`${base}/api/closePositions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ keepWeth: false, poolNum: ALGO_CONFIG.POOL_NUM, caseNum: 9, noTransfer: true }),
      signal:  AbortSignal.timeout(120000),
    });
    const data = await res.json();
    steps.closeLP = data;
    if (data.usdcBalance) closedCapital = parseFloat(data.usdcBalance) || capital;
  } catch (e) {
    steps.closeLP = { error: e.message };
    return { ok: false, steps, error: 'closeLP failed' };
  }

  // 3. Réouvrir la LP avec biais
  let newLpData = null;
  try {
    const res = await fetch(`${base}/api/createPosition`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        amountUSDC:   closedCapital,
        minPrice,
        maxPrice,
        currentPrice,
        targetRatio,
        poolNum:      ALGO_CONFIG.POOL_NUM,
        caseNum:      9,
        exactBounds:  false,
        weth_placed_hl: shortSizeEth ?? 0,
      }),
      signal: AbortSignal.timeout(180000),
    });
    newLpData = await res.json();
    steps.createLP = newLpData;
  } catch (e) {
    steps.createLP = { error: e.message };
    return { ok: false, steps, error: 'createLP failed' };
  }

  // 4. Mettre à jour l'état de position dans Redis
  const newLower = newLpData?.tickLowerPrice ?? minPrice;
  const newUpper = newLpData?.tickUpperPrice ?? maxPrice;
  const newPositionState = await savePositionState(kv, { lowerPrice: newLower, upperPrice: newUpper });
  await kv.del(REDIS_KEYS.OOR_SINCE);
  await kv.del(REDIS_KEYS.HEDGE_STATE);

  steps.newPositionState = newPositionState;
  return { ok: true, bias, targetRatio, steps };
}
