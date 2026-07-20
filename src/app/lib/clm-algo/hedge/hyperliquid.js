// Module 6 — Wrappers Hyperliquid (open/close/status short)
// Appelle les routes API existantes plutôt que @nktkas/hyperliquid directement,
// pour réutiliser la logique d'auth + normalisation des prix.

/**
 * Ouvre un short ETH avec SL.
 * @param {{ base, sizeEth, leverage, slPrice }} p
 */
export async function openShort({ base, sizeEth, leverage = 4, slPrice }) {
  const body = { sizeEth, leverage };
  if (slPrice) body.slPriceTrigger = slPrice;

  const res = await fetch(`${base}/api/hyperliquid-short`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(30000),
  });
  return res.json();
}

/**
 * Ferme tous les ordres + positions ETH short.
 * Annule d'abord les ordres ouverts (SL/TP), puis close la position en market.
 */
export async function closeShort(base) {
  const cancelRes = await fetch(`${base}/api/hyperliquid-cancel-all`, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
  });
  const cancelData = await cancelRes.json();

  // Si la position est toujours ouverte après annulation des ordres,
  // hyperliquid-cancel-all se charge aussi de fermer la position.
  return cancelData;
}

/**
 * Récupère l'état actuel du short ETH sur HL.
 * @returns {{ hasShort: bool, sizeEth: number, entryPrice: number, pnl: number }}
 */
export async function getShortState(base) {
  const res = await fetch(`${base}/api/hyperliquid-status`, {
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  const pos = (data.positions ?? []).find(p => p.coin === 'ETH' && p.side === 'short');

  if (!pos) return { hasShort: false, sizeEth: 0, entryPrice: null, pnl: 0 };

  return {
    hasShort:   true,
    sizeEth:    Math.abs(parseFloat(pos.szi ?? pos.size ?? '0')),
    entryPrice: parseFloat(pos.entryPx ?? pos.entryPrice ?? '0'),
    pnl:        parseFloat(pos.unrealizedPnl ?? '0'),
  };
}
