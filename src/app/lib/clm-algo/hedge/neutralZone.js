import { REDIS_KEYS } from '../config.js';

// Module 5 — Machine d'état du short basée sur la neutral zone

/**
 * Évalue si le short doit être ON ou OFF selon la zone de prix.
 * La neutral zone (±0.3%) sert de tampon pour éviter les allers-retours fréquents.
 *
 * Règles :
 *   price < neutralZoneLow  → short doit être ON  (LP accumule du WETH, il faut hedger)
 *   price > neutralZoneHigh → short doit être OFF  (LP accumule du USDC, pas de hedge)
 *   entre les deux          → garder l'état actuel (pas de changement = pas de frais)
 *
 * @param {{ currentPrice, positionState, hedgeState }} params
 * @returns {{ action: "open"|"close"|"keep", reason: string }}
 */
export function evaluateShortState({ currentPrice, positionState, hedgeState }) {
  const { neutralZoneLow, neutralZoneHigh } = positionState;
  const currentShortState = hedgeState?.shortState ?? 'OFF';

  if (currentPrice < neutralZoneLow) {
    if (currentShortState === 'ON') {
      return { action: 'keep', reason: `short déjà ON · prix ${currentPrice.toFixed(1)} < NZ_low ${neutralZoneLow.toFixed(1)}` };
    }
    return { action: 'open', reason: `prix ${currentPrice.toFixed(1)} < NZ_low ${neutralZoneLow.toFixed(1)} → hedge WETH` };
  }

  if (currentPrice > neutralZoneHigh) {
    if (currentShortState === 'OFF') {
      return { action: 'keep', reason: `short déjà OFF · prix ${currentPrice.toFixed(1)} > NZ_high ${neutralZoneHigh.toFixed(1)}` };
    }
    return { action: 'close', reason: `prix ${currentPrice.toFixed(1)} > NZ_high ${neutralZoneHigh.toFixed(1)} → LP en USDC` };
  }

  // Zone neutre : pas de changement
  return { action: 'keep', reason: `prix ${currentPrice.toFixed(1)} dans neutral zone [${neutralZoneLow.toFixed(1)}–${neutralZoneHigh.toFixed(1)}]` };
}

/**
 * Évalue l'état du short quand la LP est hors range.
 *   OOR lower → price < lowerPrice → LP 100% WETH → short doit être ON
 *   OOR upper → price > upperPrice → LP 100% USDC → short doit être OFF
 */
export function evaluateShortStateOOR({ zone, hedgeState }) {
  const currentShortState = hedgeState?.shortState ?? 'OFF';

  if (zone === 'oor_lower') {
    return currentShortState === 'ON'
      ? { action: 'keep',  reason: 'hors range bas · short déjà ON' }
      : { action: 'open',  reason: 'hors range bas → LP 100% WETH, ouvrir short' };
  }

  if (zone === 'oor_upper') {
    return currentShortState === 'OFF'
      ? { action: 'keep',  reason: 'hors range haut · short déjà OFF' }
      : { action: 'close', reason: 'hors range haut → LP 100% USDC, fermer short' };
  }

  return { action: 'keep', reason: 'en range' };
}

/**
 * Met à jour l'état du hedge dans Redis.
 */
export async function saveHedgeState(kv, { shortState, shortEntryPrice = null, shortSizeEth = null }) {
  const state = { shortState, shortEntryPrice, shortSizeEth, updatedAt: new Date().toISOString() };
  await kv.set(REDIS_KEYS.HEDGE_STATE, state, { ex: 86400 });
  return state;
}
