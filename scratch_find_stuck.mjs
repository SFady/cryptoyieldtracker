import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL);

const errs = await sql`
  SELECT id, created_at, error_msg, token_id
  FROM lp_events
  WHERE action1 = 'CREATE_ERR' AND COALESCE(pool_num, 2) = 2
  ORDER BY id ASC
`;

console.log("=== CREATE_ERR (échecs de création, pool 2) ===");
for (const r of errs) {
  console.log(`id=${r.id} date=${r.created_at} token_id=${r.token_id ?? 'null'}`);
  console.log(`  msg: ${r.error_msg?.slice(0, 200)}`);
}
console.log(`\nTotal CREATE_ERR: ${errs.length}`);

const openOnes = await sql`
  SELECT id, created_at, token_id, usdc_placed, total_at_open
  FROM lp_events
  WHERE action1 = 'CREATE_OK' AND action2 IS NULL AND COALESCE(pool_num, 2) = 2
  ORDER BY id ASC
`;
console.log("\n=== Positions CREATE_OK jamais marquées fermées ===");
for (const r of openOnes) {
  console.log(`id=${r.id} date=${r.created_at} token_id=${r.token_id} capital=${r.total_at_open ?? r.usdc_placed}`);
}
