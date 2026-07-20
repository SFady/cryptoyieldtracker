import { kv as kvDefault }            from '@vercel/kv';
import { ALGO_CONFIG, REDIS_KEYS }     from '../config.js';
import { getPositionState, evaluateZone, evaluateRebalance } from '../clm/position.js';
import { rebalanceCLMPosition }        from '../clm/rebalance.js';
import { evaluateShortState, evaluateShortStateOOR, saveHedgeState } from '../hedge/neutralZone.js';
import { openShort, closeShort, getShortState } from '../hedge/hyperliquid.js';
import { logBotTick }                  from './metrics.js';

// Module 7 — Orchestrateur principal, appelé depuis le cron (pool 2 uniquement)

/**
 * Charge ou dérive la configuration runtime (capital, leverage, shortSizeEth).
 * Définie au Start via /api/algo-init. Si absente, estime depuis le prix courant.
 */
async function getRuntimeConfig(kv, currentPrice) {
  const saved = await kv.get(REDIS_KEYS.RUNTIME_CONFIG);
  if (saved) return saved;
  // Fallback conservateur : short = 0.15 ETH, leverage 4
  return { capital: 0, leverage: 4, shortSizeEth: 0.15 };
}

/**
 * botLoop — appelé depuis cron/route.js à la place des blocs p2_lp + p2_short.
 *
 * @param {{ base: string, price: number }} params
 * @returns {Object} résumé de l'action pour rebalanceResults
 */
export async function botLoop({ base, price }) {
  const kv = kvDefault;
  const result = { price, ts: new Date().toISOString() };

  // 1. État de la position LP
  const positionState = await getPositionState(kv);
  if (!positionState) {
    result.skipped = true;
    result.reason  = 'pas de position LP active';
    await logBotTick(kv, result);
    return result;
  }

  // 2. Configuration runtime
  const runtimeConfig = await getRuntimeConfig(kv, price);
  const { leverage, shortSizeEth } = runtimeConfig;

  // 3. Zone courante
  const { zone, pctFromMid } = evaluateZone(price, positionState);
  result.zone       = zone;
  result.pctFromMid = parseFloat((pctFromMid * 100).toFixed(2));

  // 4. État du hedge (Redis, puis synchro HL si inconnu)
  let hedgeState = await kv.get(REDIS_KEYS.HEDGE_STATE);
  if (!hedgeState || hedgeState.shortState === 'unknown') {
    const hlState = await getShortState(base);
    hedgeState = {
      shortState:    hlState.hasShort ? 'ON' : 'OFF',
      shortSizeEth:  hlState.sizeEth || shortSizeEth,
      shortEntryPrice: hlState.entryPrice,
    };
    await saveHedgeState(kv, hedgeState);
  }
  result.hedgeStateBefore = hedgeState.shortState;

  // 5a. Hors range — décider rebalance ou ajustement short
  if (zone === 'oor_lower' || zone === 'oor_upper') {
    const { shouldRebalance, bias, minSince } = await evaluateRebalance(kv, zone);
    result.oor = { bias, minSince, shouldRebalance };

    if (shouldRebalance) {
      // Rebalance complet : ferme tout + réouvre avec biais
      result.action = 'rebalance';
      const rebResult = await rebalanceCLMPosition({ base, currentPrice: price, bias, runtimeConfig, positionState, kv });
      result.rebalance = rebResult;

      if (rebResult.ok) {
        await saveHedgeState(kv, { shortState: 'OFF', shortSizeEth, shortEntryPrice: null });
        result.hedgeStateAfter = 'OFF';
      }

      await logBotTick(kv, result);
      return result;
    }

    // Pas encore assez longtemps OOR → ajuster le short sans fermer la LP
    const { action, reason } = evaluateShortStateOOR({ zone, hedgeState });
    result.action       = `oor_wait_${action}`;
    result.hedgeReason  = reason;

    if (action === 'open') {
      const slPrice = positionState.upperPrice;
      const openResult = await openShort({ base, sizeEth: shortSizeEth, leverage, slPrice });
      result.openShort = openResult;
      if (openResult.ok) {
        await saveHedgeState(kv, { shortState: 'ON', shortSizeEth, shortEntryPrice: openResult.ethPrice });
        result.hedgeStateAfter = 'ON';
      }
    } else if (action === 'close') {
      const closeResult = await closeShort(base);
      result.closeShort = closeResult;
      await saveHedgeState(kv, { shortState: 'OFF', shortSizeEth, shortEntryPrice: null });
      result.hedgeStateAfter = 'OFF';
    } else {
      result.hedgeStateAfter = hedgeState.shortState;
    }

    await logBotTick(kv, result);
    return result;
  }

  // 5b. En range — évaluer la neutral zone
  const { action, reason } = evaluateShortState({ currentPrice: price, positionState, hedgeState });
  result.action      = `in_range_${action}`;
  result.hedgeReason = reason;

  if (action === 'open') {
    const slPrice = positionState.upperPrice;
    const openResult = await openShort({ base, sizeEth: shortSizeEth, leverage, slPrice });
    result.openShort = openResult;
    if (openResult.ok) {
      await saveHedgeState(kv, { shortState: 'ON', shortSizeEth, shortEntryPrice: openResult.ethPrice });
      result.hedgeStateAfter = 'ON';
    }
  } else if (action === 'close') {
    const closeResult = await closeShort(base);
    result.closeShort = closeResult;
    await saveHedgeState(kv, { shortState: 'OFF', shortSizeEth, shortEntryPrice: null });
    result.hedgeStateAfter = 'OFF';
  } else {
    result.hedgeStateAfter = hedgeState.shortState;
  }

  await logBotTick(kv, result);
  return result;
}
