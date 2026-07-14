import { neon } from "@neondatabase/serverless";
import { readLpState } from "../../lib/cronKv";
import { POOL_ADDRESS as POOL } from "../../lib/config";

export const runtime     = "nodejs";
export const maxDuration = 15;

const NFPM = "0x827922686190790b37229fd06084350E74485b72";
const sql  = neon(process.env.DATABASE_URL);

const RPC_URLS = [
  process.env.ALCHEMY_RPC_URL,
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
].filter(Boolean);

const M256 = 1n << 256n;
function word(h, i) { const s = h.startsWith("0x") ? h.slice(2) : h; return s.slice(i * 64, (i + 1) * 64); }
function toUint(w) { if (!w || w === "0x") return 0n; const s = w.startsWith("0x") ? w.slice(2) : w; return s ? BigInt("0x" + s) : 0n; }
function toInt(w)  { const n = toUint(w); return n >= M256 / 2n ? n - M256 : n; }
function pad64(n)  { return (((BigInt(n) % M256) + M256) % M256).toString(16).padStart(64, "0"); }

function tickToSqrtX96(tick) {
  return BigInt(Math.round(Math.exp(Number(tick) * Math.log(1.0001) / 2) * 2 ** 96));
}

function getAmounts(sqrtP, sqrtA, sqrtB, liq) {
  const Q96 = 1n << 96n;
  if (sqrtP <= sqrtA) return { a0: (liq * Q96 * (sqrtB - sqrtA)) / (sqrtA * sqrtB) };
  if (sqrtP >= sqrtB) return { a0: 0n };
  return { a0: (liq * Q96 * (sqrtB - sqrtP)) / (sqrtP * sqrtB) };
}

async function ethCall(to, data) {
  let lastErr;
  for (const url of RPC_URLS) {
    try {
      const res  = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
        signal:  AbortSignal.timeout(8000),
      });
      const json = await res.json();
      if (json.result && json.result !== "0x") return json.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error("eth_call échoué");
}

async function getTokenId(poolNum) {
  const state = await readLpState(poolNum);
  if (state?.token_id) return BigInt(state.token_id);
  const rows = await sql`
    SELECT token_id FROM lp_events
    WHERE action1 = 'CREATE_OK' AND action2 IS NULL AND COALESCE(pool_num, 2) = ${poolNum}
    ORDER BY id DESC LIMIT 1
  `;
  if (!rows[0]?.token_id) throw new Error("Aucun token_id actif trouvé");
  return BigInt(rows[0].token_id);
}

export async function GET(req) {
  const poolNum = parseInt(new URL(req.url).searchParams.get("poolNum") ?? "2");
  try {
    const tokenId = await getTokenId(poolNum);

    const posHex    = await ethCall(NFPM, "0x99fbab88" + pad64(tokenId));
    const tickLower = Number(toInt(word(posHex, 5)));
    const tickUpper = Number(toInt(word(posHex, 6)));
    const liquidity = toUint(word(posHex, 7));

    if (liquidity === 0n)
      return Response.json({ wethInPool: 0, tokenId: tokenId.toString(), note: "liquidity=0" });

    const s0Hex  = await ethCall(POOL, "0x3850c7bd");
    const sqrtP  = toUint(word(s0Hex, 0));
    const { a0 } = getAmounts(sqrtP, tickToSqrtX96(tickLower), tickToSqrtX96(tickUpper), liquidity);

    return Response.json({ wethInPool: Number(a0) / 1e18, tokenId: tokenId.toString() });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
