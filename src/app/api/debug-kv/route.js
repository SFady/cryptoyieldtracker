import { kv } from "@vercel/kv";

export const runtime = "nodejs";

export async function GET() {
  const lastRun  = await kv.get("cron-last-run");
  const count    = await kv.zcard("weth-history");
  const last10   = await kv.zrange("weth-history", 0, 9, { rev: true, withScores: true });

  const entries = [];
  for (let i = 0; i < last10.length; i += 2) {
    entries.push({
      price: parseFloat(last10[i]),
      date:  new Date(Number(last10[i + 1])).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }),
    });
  }

  return Response.json({
    totalEntries: count,
    lastRun:      lastRun ? new Date(Number(lastRun)).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }) : null,
    last10:       entries,
  });
}
