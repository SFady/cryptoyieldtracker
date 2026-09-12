import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";

const sql = neon(process.env.DATABASE_URL);

export async function GET() {
  try {
    let rows;
    try {
      rows = await sql`
        SELECT id, token_id, pool_num, total_at_open, usdc_on_close, close_reason, created_at, closed_at
        FROM lp_events
        WHERE action1 = 'CREATE_OK'
        ORDER BY id DESC
        LIMIT 200
      `;
    } catch (_) {
      // close_reason pas encore migrée en prod
      rows = await sql`
        SELECT id, token_id, pool_num, total_at_open, usdc_on_close, NULL AS close_reason, created_at, closed_at
        FROM lp_events
        WHERE action1 = 'CREATE_OK'
        ORDER BY id DESC
        LIMIT 200
      `;
    }

    const results = rows.map(r => {
      const before = r.total_at_open !== null ? parseFloat(r.total_at_open) : null;
      const after  = r.usdc_on_close !== null ? parseFloat(r.usdc_on_close) : null;
      const delta  = (before !== null && after !== null) ? parseFloat((after - before).toFixed(2)) : null;
      return {
        id:         r.id,
        tokenId:    r.token_id,
        poolNum:    r.pool_num ?? 2,
        date:       new Date(r.created_at).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }),
        closedDate: r.closed_at ? new Date(r.closed_at).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }) : null,
        before,
        after,
        delta,
        closeReason: r.close_reason,
      };
    });

    return Response.json({ results });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
