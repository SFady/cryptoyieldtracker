import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL);

const rows = await sql`
  SELECT id, created_at, token_id, pool_num, action1, action2, total_at_open, usdc_placed, usdc_remaining
  FROM lp_events
  WHERE token_id IS NOT NULL
    AND created_at >= '2026-06-15'
  ORDER BY id ASC
`;

console.log(`Total positions avec token_id depuis 15/06 : ${rows.length}`);
for (const r of rows) {
  console.log(`id=${r.id} pool=${r.pool_num ?? 2} token=${r.token_id} ${r.action1}/${r.action2 ?? 'OPEN'} capital=${r.total_at_open ?? r.usdc_placed} remaining=${r.usdc_remaining} date=${r.created_at.toISOString().slice(0,10)}`);
}
