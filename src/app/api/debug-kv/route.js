import { kv } from "@vercel/kv";
import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";

const sql = neon(process.env.DATABASE_URL);

export async function GET() {
  const [lastRun, count, last10raw, lpState2, lpErr2, lpState3, lpErr3, lpRunning, lastCronResults] = await Promise.all([
    kv.get("cron-last-run"),
    kv.zcard("weth-history"),
    kv.zrange("weth-history", 0, 9, { rev: true, withScores: true }),
    kv.get("lp-state-2"),
    kv.get("lp-err-2"),
    kv.get("lp-state-3"),
    kv.get("lp-err-3"),
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

  let lastDbRows2 = [];
  try {
    lastDbRows2 = await sql`
      SELECT id, action1, action2, range_min, range_max, range_pct, token_id, error_msg, created_at
      FROM lp_events
      WHERE COALESCE(pool_num, 2) = 2
      ORDER BY id DESC LIMIT 5
    `;
  } catch (e) {
    lastDbRows2 = [{ error: e.message }];
  }

  let lastDbRows3 = [];
  try {
    lastDbRows3 = await sql`
      SELECT id, action1, action2, range_min, range_max, range_pct, token_id, error_msg, created_at
      FROM lp_events
      WHERE pool_num = 3
      ORDER BY id DESC LIMIT 5
    `;
  } catch (e) {
    lastDbRows3 = [{ error: e.message }];
  }

  return Response.json({
    totalEntries: count,
    lastRun:      lastRun ? new Date(Number(lastRun)).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }) : null,
    last10:       entries,
    pool2: { lpState: lpState2, lpErr: lpErr2, lastDbRows: lastDbRows2 },
    pool3: { lpState: lpState3, lpErr: lpErr3, lastDbRows: lastDbRows3 },
    lpRunning:      lpRunning ?? null,
    lastCronResults,
  });
}
