import { kv } from '@vercel/kv';
import { REDIS_KEYS } from '../../lib/clm-algo/config.js';

export const runtime = 'nodejs';

/**
 * POST /api/algo-init
 * Appelé au Start (pool 2) après création de la LP.
 * Réinitialise l'état de l'algo et sauvegarde la config runtime.
 *
 * Body: { capital, leverage, shortSizeEth }
 */
export async function POST(req) {
  const { capital, leverage = 4, shortSizeEth, shortEntryPrice = null, shortStateInit = 'OFF' } =
    await req.json().catch(() => ({}));

  if (!capital || !shortSizeEth) {
    return Response.json({ error: 'capital et shortSizeEth requis' }, { status: 400 });
  }

  // Effacer l'état précédent du bot
  await Promise.all([
    kv.del(REDIS_KEYS.POSITION_STATE),
    kv.del(REDIS_KEYS.OOR_SINCE),
    kv.del('p2_oor_count'),
  ]);

  // Sauvegarder la config runtime
  const runtimeConfig = { capital, leverage, shortSizeEth, startedAt: new Date().toISOString() };
  await kv.set(REDIS_KEYS.RUNTIME_CONFIG, runtimeConfig, { ex: 30 * 86400 });

  // Sauvegarder l'état initial du hedge (si le short est déjà ouvert au Start)
  const hedgeState = {
    shortState:      shortStateInit,
    shortSizeEth,
    shortEntryPrice,
    updatedAt:       new Date().toISOString(),
  };
  await kv.set(REDIS_KEYS.HEDGE_STATE, hedgeState, { ex: 30 * 86400 });

  return Response.json({ ok: true, runtimeConfig, hedgeState });
}
