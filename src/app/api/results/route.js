import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";

const sql = neon(process.env.DATABASE_URL);

export async function GET() {
  try {
    let rows;
    try {
      rows = await sql`
        SELECT id, token_id, pool_num, total_at_open, usdc_on_close, close_reason, fees_usdc, created_at, closed_at
        FROM lp_events
        WHERE action1 = 'CREATE_OK'
        ORDER BY id DESC
        LIMIT 200
      `;
    } catch (_) {
      // close_reason/fees_usdc pas encore migrées en prod
      rows = await sql`
        SELECT id, token_id, pool_num, total_at_open, usdc_on_close, NULL AS close_reason, NULL AS fees_usdc, created_at, closed_at
        FROM lp_events
        WHERE action1 = 'CREATE_OK'
        ORDER BY id DESC
        LIMIT 200
      `;
    }

    // Transferts vers le wallet externe issus des sorties Règle 1A (edge_low/high) — à réintégrer
    // dans usdc_on_close, sinon le montant envoyé apparaît comme une perte alors qu'il est juste
    // déplacé hors du wallet du bot.
    let transfers = [];
    try {
      transfers = await sql`
        SELECT amount_usdc, pool_num, created_at
        FROM dest_transfers
        WHERE source IN ('edge_low_25pct', 'edge_high_50pct')
        ORDER BY created_at ASC
      `;
    } catch (_) {}

    const results = rows.map(r => {
      const before = r.total_at_open !== null ? parseFloat(r.total_at_open) : null;
      let after    = r.usdc_on_close !== null ? parseFloat(r.usdc_on_close) : null;

      let sentOut = 0;
      if (after !== null && r.closed_at) {
        const closedAt = new Date(r.closed_at).getTime();
        const windowMs = 10 * 60 * 1000;
        for (const t of transfers) {
          if ((t.pool_num ?? 2) !== (r.pool_num ?? 2)) continue;
          const tAt = new Date(t.created_at).getTime();
          if (tAt <= closedAt && closedAt - tAt <= windowMs) sentOut += parseFloat(t.amount_usdc);
        }
      }
      if (sentOut > 0) after = parseFloat((after + sentOut).toFixed(6));

      const delta = (before !== null && after !== null) ? parseFloat((after - before).toFixed(2)) : null;
      return {
        id:         r.id,
        tokenId:    r.token_id,
        poolNum:    r.pool_num ?? 2,
        date:       new Date(r.created_at).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }),
        closedDate: r.closed_at ? new Date(r.closed_at).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }) : null,
        before,
        after,
        aeroUsdc: r.fees_usdc !== null ? parseFloat(r.fees_usdc) : null,
        delta,
        closeReason: r.close_reason,
      };
    });

    return Response.json({ results });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
