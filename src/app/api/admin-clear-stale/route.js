import { kv } from '@vercel/kv';
import { neon } from '@neondatabase/serverless';

export const runtime = 'nodejs';

// Endpoint de maintenance : nettoie l'état interne (DB + Redis) d'une position devenue
// inutilisable (ex: NFT bloqué chez un gauge, hors de portée de notre code). N'appelle
// AUCUNE fonction de contrat Aerodrome — uniquement notre propre comptabilité, pour que
// le bot arrête de croire qu'une position morte est encore active et puisse en recréer une.

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const poolNum = body.poolNum ?? 2;
  const reason  = body.reason ?? 'stuck_at_gauge';

  // Correction ponctuelle du capital d'ouverture affiché (Redis uniquement) — n'exécute
  // pas la logique de nettoyage ci-dessous quand ce champ est fourni.
  if (body.setOpeningTotal != null) {
    try {
      await kv.set(`p${poolNum}_opening_total`, body.setOpeningTotal, { ex: 30 * 86400 });
      await kv.set(`p${poolNum}_opening_lp`,    body.setOpeningTotal, { ex: 30 * 86400 });
      return Response.json({ ok: true, poolNum, openingTotal: body.setOpeningTotal });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  }

  const sql = neon(process.env.DATABASE_URL);
  const result = { poolNum };

  try {
    const rows = await sql`
      SELECT id, token_id FROM lp_events
      WHERE COALESCE(pool_num, 2) = ${poolNum} AND action1 = 'CREATE_OK' AND action2 IS NULL
      ORDER BY id DESC
    `;
    result.dbRowsUpdated = [];
    for (const row of rows) {
      await sql`UPDATE lp_events SET action2 = 'STUCK', error_msg = ${reason} WHERE id = ${row.id}`;
      result.dbRowsUpdated.push({ id: row.id, tokenId: row.token_id });
    }
  } catch (e) {
    result.dbError = e.message;
  }

  const keysToDelete = [
    `lp-state-${poolNum}`,
    `p${poolNum}_live_range`,
    `p${poolNum}_oor_count`,
    `p${poolNum}_oor_low`,
    `p${poolNum}_low_zone_hist`,
    `p${poolNum}_high_zone_hist`,
    `p${poolNum}_hedge_fees`,
    `p${poolNum}_opening_total`,
    `p${poolNum}_opening_lp`,
    `p${poolNum}_algo_position_state`,
    `p${poolNum}_algo_hedge_state`,
    `p${poolNum}_algo_oor_since`,
    `p${poolNum}_algo_runtime_config`,
  ];

  try {
    await Promise.all(keysToDelete.map(k => kv.del(k)));
    result.redisKeysCleared = keysToDelete;
  } catch (e) {
    result.redisError = e.message;
  }

  return Response.json({ ok: true, ...result });
}
