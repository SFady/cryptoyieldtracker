// Module 8 — Logs et métriques du bot CLM

const METRICS_KEY = 'p2_algo_metrics';

/**
 * Enregistre un tick de bot dans Redis (rolling list des 50 derniers).
 */
export async function logBotTick(kv, tickData) {
  try {
    const existing = (await kv.get(METRICS_KEY)) ?? [];
    const updated  = [{ ts: new Date().toISOString(), ...tickData }, ...existing].slice(0, 50);
    await kv.set(METRICS_KEY, updated, { ex: 7 * 86400 });
  } catch (_) {}
  console.log('[clm-algo]', JSON.stringify(tickData));
}

/**
 * Lit les métriques (pour affichage UI).
 */
export async function getBotMetrics(kv) {
  return (await kv.get(METRICS_KEY)) ?? [];
}
