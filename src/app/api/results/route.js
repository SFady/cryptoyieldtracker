import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";

const sql = neon(process.env.DATABASE_URL);

export async function GET() {
  try {
    let rows;
    try {
      rows = await sql`
        SELECT id, token_id, pool_num, total_at_open, usdc_on_close, close_reason, fees_usdc, open_trend, range_min, range_max, range_pct, created_at, closed_at
        FROM lp_events
        WHERE action1 = 'CREATE_OK'
          AND COALESCE(pool_num, 2) = 2
          AND created_at >= '2026-09-16 15:06:00+02'
          AND (closed_at IS NULL OR closed_at > '2026-09-16 15:06:00+02')
        ORDER BY id DESC
        LIMIT 200
      `;
    } catch (_) {
      // close_reason/fees_usdc/open_trend pas encore migrées en prod
      rows = await sql`
        SELECT id, token_id, pool_num, total_at_open, usdc_on_close, NULL AS close_reason, NULL AS fees_usdc, NULL AS open_trend, range_min, range_max, range_pct, created_at, closed_at
        FROM lp_events
        WHERE action1 = 'CREATE_OK'
          AND COALESCE(pool_num, 2) = 2
          AND created_at >= '2026-09-16 15:06:00+02'
          AND (closed_at IS NULL OR closed_at > '2026-09-16 15:06:00+02')
        ORDER BY id DESC
        LIMIT 200
      `;
    }

    // Transferts vers le wallet externe (sorties Règles 2/3/1e/1f, claims AERO manuel, matinal 7h
    // [désactivé] ou périodique 24h [Règle 5]) — à réintégrer dans usdc_on_close, sinon le montant
    // envoyé apparaît comme une perte alors qu'il est juste déplacé hors du wallet du bot. Fenêtre =
    // toute la durée de vie du cycle (created_at → closed_at), pas seulement les minutes précédant
    // la fermeture : un claim survenant en plein milieu d'un cycle doit aussi être réintégré.
    let transfers = [];
    try {
      transfers = await sql`
        SELECT amount_usdc, pool_num, created_at
        FROM dest_transfers
        WHERE source IN ('edge_low_25pct', 'edge_high_50pct', 'claimAero', 'morning_claim_25pct', 'periodic_24h_claim')
        ORDER BY created_at ASC
      `;
    } catch (_) {}

    // Claims AERO manuel/matinal (getReward hors fermeture) — fees_usdc y stocke le delta complet
    // (part envoyée + part gardée dans le wallet), matché précisément par token_id.
    let aeroClaimByToken = {};
    try {
      const claimRows = await sql`
        SELECT token_id, fees_usdc
        FROM lp_events
        WHERE action1 = 'AERO_CLAIM' AND COALESCE(pool_num, 2) = 2 AND fees_usdc IS NOT NULL
      `;
      for (const c of claimRows) {
        aeroClaimByToken[c.token_id] = (aeroClaimByToken[c.token_id] ?? 0) + parseFloat(c.fees_usdc);
      }
    } catch (_) {}

    const results = rows.map(r => {
      const before = r.total_at_open !== null ? parseFloat(r.total_at_open) : null;
      let after    = r.usdc_on_close !== null ? parseFloat(r.usdc_on_close) : null;

      // sentOut : part effectivement sortie du wallet (edge_low/high + claims) — à réintégrer dans
      // "after", sinon l'argent envoyé apparaît comme une perte alors qu'il est juste déplacé.
      let sentOut = 0;
      if (after !== null) {
        const openAt  = new Date(r.created_at).getTime();
        const closeAt = r.closed_at ? new Date(r.closed_at).getTime() : Date.now();
        for (const t of transfers) {
          if ((t.pool_num ?? 2) !== (r.pool_num ?? 2)) continue;
          const tAt = new Date(t.created_at).getTime();
          if (tAt >= openAt && tAt <= closeAt) sentOut += parseFloat(t.amount_usdc);
        }
      }
      if (sentOut > 0) after = parseFloat((after + sentOut).toFixed(6));

      // Fees affichées = AERO collecté à la fermeture (fees_usdc) + AERO des claims manuel/matinal
      // sur cette position (delta complet, envoyé + gardé) — edge_low/high ne sont PAS réajoutés
      // ici, ils sont déjà comptés dans fees_usdc (même close event).
      const claimTotal = aeroClaimByToken[r.token_id] ?? 0;
      const aeroUsdc    = (r.fees_usdc !== null ? parseFloat(r.fees_usdc) : 0) + claimTotal;

      const delta = (before !== null && after !== null) ? parseFloat((after - before).toFixed(2)) : null;
      return {
        id:         r.id,
        tokenId:    r.token_id,
        poolNum:    r.pool_num ?? 2,
        date:       new Date(r.created_at).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }),
        closedDate: r.closed_at ? new Date(r.closed_at).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }) : null,
        before,
        after,
        aeroUsdc: (r.fees_usdc !== null || claimTotal > 0) ? parseFloat(aeroUsdc.toFixed(6)) : null,
        delta,
        closeReason: r.close_reason,
        openTrend:  r.open_trend,
        rangeMin: r.range_min !== null ? parseFloat(r.range_min) : null,
        rangeMax: r.range_max !== null ? parseFloat(r.range_max) : null,
        rangePct: r.range_pct !== null ? parseFloat(r.range_pct) : null,
      };
    });

    return Response.json({ results });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
