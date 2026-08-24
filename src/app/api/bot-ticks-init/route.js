import { neon } from '@neondatabase/serverless';

export const runtime = 'nodejs';

export async function GET() {
  const sql = neon(process.env.DATABASE_URL);
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS bot_ticks (
        id           BIGSERIAL PRIMARY KEY,
        ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        pool_num     SMALLINT    NOT NULL DEFAULT 2,
        price        NUMERIC(12,2),
        action       VARCHAR(60),
        has_lp       BOOLEAN,
        has_short    BOOLEAN,
        is_oor       BOOLEAN,
        range_min    NUMERIC(12,2),
        range_max    NUMERIC(12,2),
        bucket       INTEGER,
        weth_in_pool NUMERIC(12,6),
        short_size   NUMERIC(12,6),
        short_target NUMERIC(12,6),
        short_delta  NUMERIC(12,6),
        capital      NUMERIC(12,2),
        eth_at_open  NUMERIC(12,6),
        short_entry  NUMERIC(12,2),
        usdc_recovered NUMERIC(12,2),
        details      JSONB
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_bot_ticks_pool_ts ON bot_ticks (pool_num, ts DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_bot_ticks_action  ON bot_ticks (action)`;
    return Response.json({ ok: true, message: 'Table bot_ticks créée' });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
