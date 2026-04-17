export const runtime    = "nodejs";
export const maxDuration = 30; // secondes — nécessaire sur Vercel (défaut 10s insuffisant)

// Aerodrome CL — WETH/USDC (Base)
const POSITION_ID = 66576887n;
const NFPM = "0x827922686190790b37229fd06084350E74485b72";
const POOL = "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";

// RPCs fiables depuis les IPs cloud (AWS/Vercel) — ordered by cloud reliability
const RPC_URLS = [
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://mainnet.base.org",
  "https://base.gateway.tenderly.co",
  "https://1rpc.io/base",
];

const TOKENS = {
  "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18 },
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6 },
};

const CACHE_TTL_MS = 120_000; // 2 minutes
global._cytPositionsCache = { data: null, time: 0 };

// ── Helpers ──────────────────────────────────────────────────────────────────

const M256 = 1n << 256n;
function pad64(n) { return (((BigInt(n) % M256) + M256) % M256).toString(16).padStart(64, "0"); }
function word(h, i) { const s = h.startsWith("0x") ? h.slice(2) : h; return s.slice(i * 64, (i + 1) * 64); }
function toUint(w) { return BigInt("0x" + w); }
function toInt(w) { const n = toUint(w); return n >= M256 / 2n ? n - M256 : n; }
function toAddr(w) { return "0x" + w.slice(24).toLowerCase(); }
function mod256(n) { return ((n % M256) + M256) % M256; }

// Sélectionne un seul RPC fonctionnel — toutes les calls de la requête l'utilisent
// → données cohérentes car issues du même nœud/bloc
async function pickRpc() {
  for (const url of RPC_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        signal: AbortSignal.timeout(4000),
      });
      const json = await res.json();
      if (json.result) return url;
    } catch { /* essayer le suivant */ }
  }
  throw new Error("Aucun RPC disponible");
}

function makeCall(rpcUrl) {
  return async function call(to, data) {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
  };
}

// ── CL math ──────────────────────────────────────────────────────────────────

function tickToSqrtX96(tick) {
  return BigInt(Math.round(Math.exp(Number(tick) * Math.log(1.0001) / 2) * 2 ** 96));
}

function getAmounts(sqrtP, sqrtA, sqrtB, liq) {
  const Q96 = 1n << 96n;
  if (sqrtP <= sqrtA) return { a0: (liq * Q96 * (sqrtB - sqrtA)) / (sqrtA * sqrtB), a1: 0n };
  if (sqrtP >= sqrtB) return { a0: 0n, a1: (liq * (sqrtB - sqrtA)) / Q96 };
  return {
    a0: (liq * Q96 * (sqrtB - sqrtP)) / (sqrtP * sqrtB),
    a1: (liq * (sqrtP - sqrtA)) / Q96,
  };
}

function calcFees(liquidity, fgInside, fgInsideLast, owed) {
  const Q128 = 1n << 128n;
  const delta = mod256(fgInside - fgInsideLast);
  // Si delta > 2^200, la soustraction a débordé (fgInside < fgInsideLast) → pas de nouveaux frais
  if (delta > (1n << 200n)) return owed;
  return owed + (liquidity * delta) / Q128;
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function GET() {
  const c = global._cytPositionsCache;
  if (c.data && Date.now() - c.time < CACHE_TTL_MS) return Response.json(c.data);

  try {
    const call = makeCall(await pickRpc()); // un seul RPC pour toute la requête

    // 1. Position data
    const posHex = await call(NFPM, "0x99fbab88" + pad64(POSITION_ID));
    const token0     = toAddr(word(posHex, 2));
    const token1     = toAddr(word(posHex, 3));
    const tickLower  = Number(toInt(word(posHex, 5)));
    const tickUpper  = Number(toInt(word(posHex, 6)));
    const liquidity  = toUint(word(posHex, 7));
    const fgInsideLast0 = toUint(word(posHex, 8));
    const fgInsideLast1 = toUint(word(posHex, 9));
    const owed0 = toUint(word(posHex, 10));
    const owed1 = toUint(word(posHex, 11));

    const t0 = TOKENS[token0] ?? { symbol: "TK0", decimals: 18 };
    const t1 = TOKENS[token1] ?? { symbol: "TK1", decimals: 6 };

    // 2. Pool state + ticks (parallel)
    const [s0Hex, fg0Hex, fg1Hex, tLowHex, tUpHex] = await Promise.all([
      call(POOL, "0x3850c7bd"),
      call(POOL, "0xf3058399"),
      call(POOL, "0x46141319"),
      call(POOL, "0xf30dba93" + pad64(tickLower)),
      call(POOL, "0xf30dba93" + pad64(tickUpper)),
    ]);

    const sqrtP    = toUint(word(s0Hex, 0));
    const currTick = Number(toInt(word(s0Hex, 1)));
    const fg0 = toUint(word(fg0Hex, 0));
    const fg1 = toUint(word(fg1Hex, 0));

    // Aerodrome CL : ticks() has extra stakedLiquidityNet field → feeGrowth at slot 3/4
    const fgLow0 = toUint(word(tLowHex, 3));
    const fgLow1 = toUint(word(tLowHex, 4));
    const fgUp0  = toUint(word(tUpHex, 3));
    const fgUp1  = toUint(word(tUpHex, 4));

    const fgBelow0 = currTick >= tickLower ? fgLow0 : mod256(fg0 - fgLow0);
    const fgBelow1 = currTick >= tickLower ? fgLow1 : mod256(fg1 - fgLow1);
    const fgAbove0 = currTick < tickUpper  ? fgUp0  : mod256(fg0 - fgUp0);
    const fgAbove1 = currTick < tickUpper  ? fgUp1  : mod256(fg1 - fgUp1);

    const fgInside0 = mod256(fg0 - fgBelow0 - fgAbove0);
    const fgInside1 = mod256(fg1 - fgBelow1 - fgAbove1);

    const totalOwed0 = calcFees(liquidity, fgInside0, fgInsideLast0, owed0);
    const totalOwed1 = calcFees(liquidity, fgInside1, fgInsideLast1, owed1);

    // 3. Token amounts
    const { a0, a1 } = getAmounts(sqrtP, tickToSqrtX96(tickLower), tickToSqrtX96(tickUpper), liquidity);

    const bal0 = Number(a0) / 10 ** t0.decimals;
    const bal1 = Number(a1) / 10 ** t1.decimals;
    const fee0 = Number(totalOwed0) / 10 ** t0.decimals;
    const fee1 = Number(totalOwed1) / 10 ** t1.decimals;

    // 4. ETH price from sqrtPriceX96
    const ethPrice = Number((sqrtP * sqrtP * 10n ** 12n) / (1n << 192n));

    const usd = (sym, amt) => sym === "WETH" ? amt * ethPrice : amt;
    const inRange = currTick >= tickLower && currTick < tickUpper;

    const totalPoolUSD = usd(t0.symbol, bal0) + usd(t1.symbol, bal1);
    const totalFeesUSD = usd(t0.symbol, fee0) + usd(t1.symbol, fee1);

    const payload = {
      protocol: "Aerodrome CL",
      chain: "Base",
      tokenId: POSITION_ID.toString(),
      pair: `${t0.symbol} / ${t1.symbol}`,
      inRange,
      pool: [
        { symbol: t0.symbol, balance: bal0.toFixed(6), usd: usd(t0.symbol, bal0).toFixed(2) },
        { symbol: t1.symbol, balance: bal1.toFixed(2), usd: usd(t1.symbol, bal1).toFixed(2) },
      ],
      fees: [
        { symbol: t0.symbol, balance: fee0.toFixed(6), usd: usd(t0.symbol, fee0).toFixed(2) },
        { symbol: t1.symbol, balance: fee1.toFixed(2), usd: usd(t1.symbol, fee1).toFixed(2) },
      ],
      totalPoolUSD: totalPoolUSD.toFixed(2),
      totalFeesUSD: totalFeesUSD.toFixed(2),
      totalUSD: (totalPoolUSD + totalFeesUSD).toFixed(2),
      wethPrice: ethPrice.toFixed(2),
    };

    global._cytPositionsCache = { data: payload, time: Date.now() };
    return Response.json(payload);

  } catch (err) {
    if (global._cytPositionsCache.data) return Response.json(global._cytPositionsCache.data);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
