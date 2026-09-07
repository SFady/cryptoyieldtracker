// Module 8bis — Logs et métriques du bot CLM pool 3 (copie isolée de metrics.js, clé distincte)

const METRICS_KEY = 'p3_algo_metrics';

/**
 * Enregistre un tick dans Redis (rolling 50).
 */
export async function logBotTick(kv, tickData) {
  try {
    const existing = (await kv.get(METRICS_KEY)) ?? [];
    const updated  = [{ ts: new Date().toISOString(), ...tickData }, ...existing].slice(0, 50);
    await kv.set(METRICS_KEY, updated, { ex: 7 * 86400 });
  } catch (_) {}
  console.log('[clm-algo-p3]', JSON.stringify(tickData));
}

/**
 * Lit les métriques Redis (pour affichage UI).
 */
export async function getBotMetrics(kv) {
  return (await kv.get(METRICS_KEY)) ?? [];
}
