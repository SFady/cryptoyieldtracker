import { neon } from "@neondatabase/serverless";
import { kv } from "@vercel/kv";
import { writeCronPrice, getLastTwoPrices, readLpState, writeLpState } from "../../lib/cronKv";
import { POOL_ADDRESS } from "../../lib/config";

export const runtime     = "nodejs";
export const maxDuration = 300;

const sql = neon(process.env.DATABASE_URL);

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

  // Détermine le cas à appeler : Redis en priorité, fallback DB
  async function pickCase(poolNum) {
    if (!price) return null;
    try {
      let state = await readLpState(poolNum);
      if (!state) {
        const rows = await sql`
          SELECT usdc_placed, range_pct, range_min, range_max, action2, created_at, usdc_remaining, token_id
          FROM lp_events
          WHERE action1 = 'CREATE_OK' AND COALESCE(pool_num, 2) = ${poolNum}
          ORDER BY id DESC LIMIT 1
        `;
        state = rows[0] ?? null;
        if (state) await writeLpState(poolNum, state);
      }
      if (!state || state.action2 !== null) return 4;
      const rMin = parseFloat(state.range_min);
      const rMax = parseFloat(state.range_max);
      if (!isNaN(rMin) && price < rMin) return 1;
      if (!isNaN(rMax) && price > rMax) return 2;
      return 3;
    } catch (_) {
      return null;
    }
  }

  if (base) {
    // Pool 2 — LP management + delta-hedge short indépendant
    if (process.env.PRIVATE_KEY) {
      const caseNum2 = await pickCase(2);

      // 1. Gestion LP : ferme et repositionne si hors range
      if (caseNum2 === 1 || caseNum2 === 2) {
        try {
          const res = await fetch(`${base}/api/autoRebalance?case=9&poolNum=2`, { signal: AbortSignal.timeout(280000) });
          rebalanceResults["p2_lp"] = { trigger: `hors range (cas ${caseNum2})`, ...(await res.json()) };
        } catch (e) {
          rebalanceResults["p2_lp"] = { error: e.message };
        }
      } else {
        rebalanceResults["p2_lp"] = { skipped: true, reason: caseNum2 === null ? "pas de position active" : "en range" };
      }

      // 2. Delta-hedge short : cible WETH réel en pool, ajuste si écart > 20%
      if (caseNum2 === 3) {
        try {
          const state2  = await readLpState(2);
          const slPrice = parseFloat(state2?.range_max);
          const tpPrice = parseFloat(state2?.range_min);

          const [wethRes, hlRes] = await Promise.all([
            fetch(`${base}/api/pool-weth?poolNum=2`, { signal: AbortSignal.timeout(10000) }),
            fetch(`${base}/api/hyperliquid-status`,  { signal: AbortSignal.timeout(10000) }),
          ]);
          const wethData   = await wethRes.json();
          const hlJson     = await hlRes.json();
          const wethInPool = wethData.wethInPool ?? 0;
          const hlShort    = (hlJson.positions ?? []).find(p => p.coin === "ETH" && p.side === "short");
          const shortEth   = hlShort ? Math.abs(parseFloat(hlShort.szi ?? "0")) : 0;

          if (wethInPool < 0.001) {
            // WETH quasi nul en pool → fermer le short résiduel si existant
            if (shortEth > 0.001) {
              await fetch(`${base}/api/hyperliquid-cancel-all`, { method: "POST", signal: AbortSignal.timeout(30000) });
              rebalanceResults["p2_short"] = { action: "closed", reason: "wethInPool < 0.001", wethInPool, shortEth };
            } else {
              rebalanceResults["p2_short"] = { skipped: true, reason: "wethInPool < 0.001, pas de short", wethInPool };
            }
          } else {
            const drift = shortEth > 0 ? Math.abs(shortEth - wethInPool) / wethInPool : 1;
            if (drift <= 0.20 && shortEth > 0) {
              rebalanceResults["p2_short"] = { skipped: true, reason: `drift ${(drift * 100).toFixed(1)}% ≤ 20%`, wethInPool, shortEth };
            } else {
              // Ajustement : cancel-all puis nouveau short calibré sur WETH en pool
              if (shortEth > 0) {
                await fetch(`${base}/api/hyperliquid-cancel-all`, { method: "POST", signal: AbortSignal.timeout(30000) });
                await new Promise(r => setTimeout(r, 1000));
              }
              const body = { sizeEth: wethInPool, leverage: 4 };
              if (slPrice && !isNaN(slPrice)) body.slPriceTrigger = slPrice;
              if (tpPrice && !isNaN(tpPrice)) body.tpPriceTrigger = tpPrice;
              const shortRes  = await fetch(`${base}/api/hyperliquid-short`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
              });
              const shortData = await shortRes.json();
              rebalanceResults["p2_short"] = {
                action: "adjusted", wethInPool, shortEth,
                drift: parseFloat((drift * 100).toFixed(1)),
                slPrice: isNaN(slPrice) ? null : slPrice,
                tpPrice: isNaN(tpPrice) ? null : tpPrice,
                shortData,
              };
            }
          }
        } catch (e) {
          rebalanceResults["p2_short"] = { error: e.message };
        }
      } else {
        rebalanceResults["p2_short"] = { skipped: true, reason: `LP caseNum=${caseNum2}, pas en range actif` };
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
  try { await kv.set("cron-last-results", { ranAt, weth: price, results: rebalanceResults }, { ex: 7200 }); } catch (_) {}
  return Response.json({ ok: true, ranAt, weth: price, rebalanceResults });
}

export const GET  = handle;
export const POST = handle;
