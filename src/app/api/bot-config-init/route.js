import { neon } from '@neondatabase/serverless';

export const runtime = 'nodejs';

// Table clé/valeur générique pour les paramètres du bot ajustables sans redéploiement
// (repli DB de src/app/lib/cronKv.js:readBotConfigNumber/writeBotConfigNumber, Redis en priorité).
export async function GET() {
  const sql = neon(process.env.DATABASE_URL);
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS bot_config (
        key        TEXT PRIMARY KEY,
        value      NUMERIC NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    // Seed initial de K (Règle 1) à 1 (comportement actuel : range = percentile24h × 1) —
    // n'écrase rien si déjà présent.
    await sql`
      INSERT INTO bot_config (key, value) VALUES ('p2_rule1_k', 1)
      ON CONFLICT (key) DO NOTHING
    `;
    return Response.json({ ok: true, message: 'Table bot_config créée (p2_rule1_k seedé à 1 si absent)' });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
