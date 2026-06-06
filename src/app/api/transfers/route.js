import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";

const sql = neon(process.env.DATABASE_URL);

const WALLET2 = "0xac383af8f62a73a6b156ffa86eb2820bd6a3a2f6";
const wallet2Short = WALLET2.slice(0, 6) + "…" + WALLET2.slice(-3);
const WALLET3 = (process.env.WALLET_ADDRESS_3 ?? "").toLowerCase();
const wallet3Short = WALLET3.length >= 9 ? WALLET3.slice(0, 6) + "…" + WALLET3.slice(-3) : "Pool 3";

function formatSource(source) {
  if (!source) return "";
  const m = source.match(/^cas(\d+)/i);
  if (m) return `Cas ${m[1]}`;
  if (source === "claimAero") return "Claim";
  return source;
}

export async function GET() {
  try {
    const rows = await sql`
      SELECT created_at, amount_usdc, source, tx_hash, pool_num
      FROM dest_transfers
      ORDER BY created_at DESC
      LIMIT 100
    `;
    const fmt = rows.map(r => ({
      date:    new Date(r.created_at).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }),
      amount:  parseFloat(r.amount_usdc).toFixed(2),
      source:  formatSource(r.source),
      txHash:  r.tx_hash ?? "",
      poolNum: r.pool_num ?? 2,
    }));
    return Response.json({ transfers: fmt, wallet2Short, wallet3Short });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
