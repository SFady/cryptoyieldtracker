import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";

const sql = neon(process.env.DATABASE_URL);

export async function GET(req) {
  const p       = new URL(req.url).searchParams;
  const poolNum = parseInt(p.get("poolNum") ?? "2");
  const page    = Math.max(1, parseInt(p.get("page") ?? "1"));
  const limit   = 10;
  const offset  = (page - 1) * limit;

  try {
    const [rows, countRes] = await Promise.all([
      sql`SELECT id, action1, action2, error_msg, usdc_on_close, token_id, created_at
          FROM lp_events
          WHERE action1 != 'RUNNING' AND COALESCE(pool_num, 2) = ${poolNum}
          ORDER BY id DESC
          LIMIT ${limit} OFFSET ${offset}`,
      sql`SELECT COUNT(*)::int AS n FROM lp_events
          WHERE action1 != 'RUNNING' AND COALESCE(pool_num, 2) = ${poolNum}`,
    ]);
    return Response.json({
      rows,
      total: countRes[0].n,
      page,
      pages: Math.ceil(countRes[0].n / limit),
      lastRow: rows[0] ?? null,
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
