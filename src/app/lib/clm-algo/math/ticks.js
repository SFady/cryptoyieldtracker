import { ALGO_CONFIG } from '../config.js';

// Module 2 — Conversion prix ↔ tick + valeur CLM

export function priceToTick(price) {
  const rawTick = Math.log(price) / Math.log(1.0001);
  return Math.round(rawTick / ALGO_CONFIG.TICK_SPACING) * ALGO_CONFIG.TICK_SPACING;
}

export function tickToPrice(tick) {
  return Math.pow(1.0001, tick);
}

/**
 * Calcule la valeur d'une position CLM à un prix donné.
 * Formules Uniswap v3 basées sur √P (racine carrée du prix).
 * @returns { wethAmount, usdcAmount, totalValue }
 */
export function calculateCLMValue(currentPrice, lowerPrice, upperPrice, capital) {
  const sqrtP     = Math.sqrt(currentPrice);
  const sqrtPLow  = Math.sqrt(lowerPrice);
  const sqrtPHigh = Math.sqrt(upperPrice);
  const sqrtPMid  = Math.sqrt(Math.sqrt(lowerPrice * upperPrice));

  const denom = (sqrtPMid - sqrtPLow) + (1 / sqrtPMid - 1 / sqrtPHigh) * currentPrice;
  if (denom === 0) return { wethAmount: 0, usdcAmount: capital, totalValue: capital };
  const L = capital / denom;

  let wethAmount, usdcAmount;

  if (currentPrice <= lowerPrice) {
    wethAmount = L * (1 / sqrtPLow - 1 / sqrtPHigh);
    usdcAmount = 0;
  } else if (currentPrice >= upperPrice) {
    wethAmount = 0;
    usdcAmount = L * (sqrtPHigh - sqrtPLow);
  } else {
    wethAmount = L * (1 / sqrtP - 1 / sqrtPHigh);
    usdcAmount = L * (sqrtP - sqrtPLow);
  }

  return { wethAmount, usdcAmount, totalValue: wethAmount * currentPrice + usdcAmount };
}
