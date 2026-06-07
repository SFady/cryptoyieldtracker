import { kv } from "@vercel/kv";
import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";

const sql = neon(process.env.DATABASE_URL);

export async function GET() {
  const [lastRun, count, last10raw, lpState2, lpErr2, lpRunning, lastCronResults] = await Promise.all([
    kv.get("cron-last-run"),
    kv.zcard("weth-history"),
    kv.zrange("weth-history", 0, 9, { rev: true, withScores: true }),
    kv.get("lp-state-2"),
    kv.get("lp-err-2"),
    kv.get("lp-running"),
    kv.get("cron-last-results"),
  ]);

  const entries = [];
  for (let i = 0; i < last10raw.length; i += 2) {
    entries.push({
      price: parseFloat(last10raw[i]),
      date:  new Date(Number(last10raw[i + 1])).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }),
    });
  }

  let lastDbRows = [];
  try {
    lastDbRows = await sql`
      SELECT id, action1, action2, range_min, range_max, range_pct, token_id, error_msg, created_at
      FROM lp_events
      WHERE COALESCE(pool_num, 2) = 2
      ORDER BY id DESC LIMIT 5
    `;
  } catch (e) {
    lastDbRows = [{ error: e.message }];
  }

  return Response.json({
    totalEntries: count,
    lastRun:      lastRun ? new Date(Number(lastRun)).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }) : null,
    last10:       entries,
    lpState2,
    lpErr2,
    lpRunning:        lpRunning ?? null,
    lastCronResults,
    lastDbRows,
  });
}
