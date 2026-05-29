import { neon } from "@neondatabase/serverless";
import { writeCronPrice, getLastTwoPrices } from "../../lib/cronKv";

export const runtime     = "nodejs";
export const maxDuration = 300;

const sql = neon(process.env.DATABASE_URL);

const POOL_ADDRESS = "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";
const RPC_URLS = [
  process.env.ALCHEMY_RPC_URL,
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
].filter(Boolean);

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

  // 1. Enregistrement du prix
  let price = null;
  try {
    price = await getPoolWethPrice();

    // Vérification variation brutale : rejet si écart > 30% par rapport au dernier prix connu (Redis)
    if (price) {
      try {
        const last = await getLastTwoPrices();
        const lastPrice = last[0] ?? null;
        if (lastPrice && Math.abs(price - lastPrice) / lastPrice > 0.3) {
          console.warn(`[cron] Prix suspect ignoré : ${price} (dernier : ${lastPrice})`);
          price = null;
        }
      } catch (_) {}
    }

    if (price) await writeCronPrice(price);
  } catch (e) {
    return Response.json({ ok: false, ranAt, kvError: e.message }, { status: 500 });
  }

  // 2. Rebalance — détermine le cas pertinent via 1 lecture DB, puis appel ciblé
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  const rebalanceResults = {};

  // Détermine le cas à appeler : 1 seule lecture lp_events par pool
  async function pickCase(poolNum) {
    if (!price) return null;
    try {
      const rows = await sql`
        SELECT range_min, range_max, created_at, action2
        FROM lp_events
        WHERE action1 = 'CREATE_OK' AND COALESCE(pool_num, 2) = ${poolNum}
        ORDER BY id DESC LIMIT 1
      `;
      if (rows.length === 0 || rows[0].action2 !== null) return 4; // pas de position ouverte
      const { range_min, range_max } = rows[0];
      const rMin = parseFloat(range_min);
      const rMax = parseFloat(range_max);
      if (!isNaN(rMin) && price < rMin) return 1; // sous le range
      if (!isNaN(rMax) && price > rMax) return 2; // au-dessus du range
      return 3; // in range (autoRebalance vérifiera l'âge 6h)
    } catch (_) {
      return null; // si DB inaccessible, on ne rebalance pas
    }
  }

  if (base) {
    // Cas 5 : collecte de fees — toujours tenté en premier
    try {
      const res  = await fetch(`${base}/api/autoRebalance?case=5&poolNum=2`, { signal: AbortSignal.timeout(280000) });
      rebalanceResults[5] = await res.json();
    } catch (e) {
      rebalanceResults[5] = { error: e.message };
    }

    // Appel ciblé du seul cas pertinent
    const caseNum = await pickCase(2);
    if (caseNum) {
      try {
        const res  = await fetch(`${base}/api/autoRebalance?case=${caseNum}&poolNum=2`, { signal: AbortSignal.timeout(280000) });
        rebalanceResults[caseNum] = await res.json();
      } catch (e) {
        rebalanceResults[caseNum] = { error: e.message };
      }
    }

    // Pool 3 (si PRIVATE_KEY_3 configuré)
    console.log("[cron] pool2 results:", JSON.stringify(rebalanceResults));
    console.log("[cron] PRIVATE_KEY_3 présent:", !!process.env.PRIVATE_KEY_3);
    if (process.env.PRIVATE_KEY_3) {
      try {
        const res  = await fetch(`${base}/api/autoRebalance?case=5&poolNum=3`, { signal: AbortSignal.timeout(280000) });
        rebalanceResults[`p3_5`] = await res.json();
      } catch (e) {
        rebalanceResults[`p3_5`] = { error: e.message };
      }

      const caseNum3 = await pickCase(3);
      if (caseNum3) {
        try {
          const res  = await fetch(`${base}/api/autoRebalance?case=${caseNum3}&poolNum=3`, { signal: AbortSignal.timeout(280000) });
          rebalanceResults[`p3_${caseNum3}`] = await res.json();
        } catch (e) {
          rebalanceResults[`p3_${caseNum3}`] = { error: e.message };
        }
      }
    }
  }

  console.log("[cron] pool3 results:", JSON.stringify(rebalanceResults).slice(0, 500));
  return Response.json({ ok: true, ranAt, weth: price, rebalanceResults });
}

export const GET  = handle;
export const POST = handle;
