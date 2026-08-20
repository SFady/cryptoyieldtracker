import { kv }         from '@vercel/kv';
import { REDIS_KEYS } from '../../lib/clm-algo/config.js';
import { readLpState } from '../../lib/cronKv.js';
import { ALGO_CONFIG } from '../../lib/clm-algo/config.js';

export const runtime     = 'nodejs';
export const maxDuration = 15;

/**
 * POST /api/algo-patch-l
 * Calcule liquidityL depuis capital + bornes range (Pa, Pb) stockés en Redis/DB
 * et l'injecte dans RUNTIME_CONFIG sans fermer la position.
 * Utile quand la position a été ouverte avant que liquidityL soit sauvegardé.
 */
export async function POST() {
  try {
    const rtConfig = await kv.get(REDIS_KEYS.RUNTIME_CONFIG);
    if (!rtConfig) return Response.json({ error: 'RUNTIME_CONFIG absent (pas de position active)' }, { status: 404 });
    if (rtConfig.liquidityL) {
      return Response.json({ ok: true, skipped: true, reason: 'liquidityL déjà présent', liquidityL: rtConfig.liquidityL });
    }

    const capital = rtConfig.capital;
    if (!capital || capital < 1) return Response.json({ error: `capital invalide : ${capital}` }, { status: 400 });

    const lpState = await readLpState(ALGO_CONFIG.POOL_NUM);
    if (!lpState?.range_min || !lpState?.range_max)
      return Response.json({ error: 'lpState ou range introuvable' }, { status: 404 });

    const Pa = parseFloat(lpState.range_min);
    const Pb = parseFloat(lpState.range_max);

    // P0 = √(Pa × Pb) — prix d'équilibre 50/50 de la position CL
    const P0     = Math.sqrt(Pa * Pb);
    const sqrtP0 = Math.sqrt(P0);
    const sqrtPa = Math.sqrt(Pa);
    const sqrtPb = Math.sqrt(Pb);

    const L         = capital / (2 * sqrtP0 - P0 / sqrtPb - sqrtPa);
    const ethCheck  = parseFloat((L * (1 / sqrtP0 - 1 / sqrtPb)).toFixed(4));

    await kv.set(REDIS_KEYS.RUNTIME_CONFIG, {
      ...rtConfig,
      liquidityL:    L,
      tickUpperPrice: Pb,
    }, { ex: 30 * 86400 });

    return Response.json({
      ok: true,
      capital, Pa, Pb, P0: parseFloat(P0.toFixed(4)),
      liquidityL: parseFloat(L.toFixed(4)),
      ethCheck,
      stored_shortSizeEth: rtConfig.shortSizeEth,
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
