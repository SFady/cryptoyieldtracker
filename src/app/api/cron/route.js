import { neon } from "@neondatabase/serverless";

export const runtime     = "nodejs";
export const maxDuration = 10;

const sql = neon(process.env.DATABASE_URL);

const POOL_ADDRESS = "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";
const RPC_URLS = [
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
];

async function getPoolWethPrice() {
  for (const url of RPC_URLS) {
    try {
      const res  = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: POOL_ADDRESS, data: "0x3850c7bd" }, "latest"] }),
        signal:  AbortSignal.timeout(6000),
      });
      const json = await res.json();
      if (json.result && json.result !== "0x") {
        const sqrtPriceX96 = BigInt("0x" + json.result.slice(2, 66));
        const sqrtP = Number(sqrtPriceX96) / Number(2n ** 96n);
        const price = sqrtP * sqrtP * 1e12;
        if (price > 100 && price < 100000) return parseFloat(price.toFixed(2));
      }
    } catch (_) {}
  }
  return null;
}

function checkAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth  = req.headers.get("authorization") ?? "";
  const query = new URL(req.url).searchParams.get("secret") ?? "";
  return auth === `Bearer ${secret}` || query === secret;
}

async function handle(req) {
  if (!checkAuth(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const ranAt = new Date().toISOString();
  try {
    const price = await getPoolWethPrice();
    await sql`DELETE FROM cron_runs WHERE ran_at < NOW() - INTERVAL '24 hours'`;
    await sql`INSERT INTO cron_runs (ran_at, weth) VALUES (NOW(), ${price ?? null})`;
    return Response.json({ ok: true, ranAt, weth: price });
  } catch (e) {
    return Response.json({ ok: false, ranAt, dbError: e.message }, { status: 500 });
  }
}

export const GET  = handle;
export const POST = handle;
