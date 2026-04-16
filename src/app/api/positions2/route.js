// Aerodrome CL — position #66772892 — wallet 0xac383af8f62a73a6b156ffa86eb2820bd6a3a2f6
const POSITION_ID = 66772892n;
const NFPM = "0x827922686190790b37229fd06084350E74485b72";
const POOL = "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59"; // WETH/USDC tickSpacing=100

const RPC_URLS = [
  "https://base-rpc.publicnode.com",
  "https://base.drpc.org",
  "https://1rpc.io/base",
  "https://mainnet.base.org",
];

const KNOWN_TOKENS = {
  "0x4200000000000000000000000000000000000006": { symbol: "WETH",  decimals: 18 },
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC",  decimals: 6  },
  "0x940181a94a35a4569e4529a3cdfb74e38fd98631": { symbol: "AERO",  decimals: 18 },
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": { symbol: "DAI",   decimals: 18 },
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": { symbol: "cbBTC", decimals: 8  },
  "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22": { symbol: "cbETH", decimals: 18 },
};

const CACHE_TTL_MS = 30_000;
global._cytPos2Cache = { data: null, time: 0 };

// ── Helpers ───────────────────────────────────────────────────────────────────

const M256 = 1n << 256n;
function pad64(n) { return (((BigInt(n) % M256) + M256) % M256).toString(16).padStart(64, "0"); }
function word(h, i) { const s = h.startsWith("0x") ? h.slice(2) : h; return s.slice(i * 64, (i + 1) * 64); }
function toUint(w) { return BigInt("0x" + (w || "0")); }
function toInt(w)  { const n = toUint(w); return n >= M256 / 2n ? n - M256 : n; }
function toAddr(w) { return "0x" + w.slice(24).toLowerCase(); }
function mod256(n) { return ((n % M256) + M256) % M256; }

async function call(to, data) {
  let last;
  for (const url of RPC_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
        signal: AbortSignal.timeout(5000),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      return json.result;
    } catch (e) { last = e; }
  }
  throw last;
}

// ── CL math ───────────────────────────────────────────────────────────────────

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

function calcFees(liq, fgInside, fgInsideLast, owed) {
  const Q128 = 1n << 128n;
  return owed + (liq * mod256(fgInside - fgInsideLast)) / Q128;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET() {
  const c = global._cytPos2Cache;
  if (c.data && Date.now() - c.time < CACHE_TTL_MS) return Response.json(c.data);

  try {
    // 1. Position data
    const posHex = await call(NFPM, "0x99fbab88" + pad64(POSITION_ID));
    const token0Addr    = toAddr(word(posHex, 2));
    const token1Addr    = toAddr(word(posHex, 3));
    const tickLower     = Number(toInt(word(posHex, 5)));
    const tickUpper     = Number(toInt(word(posHex, 6)));
    const liquidity     = toUint(word(posHex, 7));
    const fgInsideLast0 = toUint(word(posHex, 8));
    const fgInsideLast1 = toUint(word(posHex, 9));
    const owed0         = toUint(word(posHex, 10));
    const owed1         = toUint(word(posHex, 11));

    const t0 = KNOWN_TOKENS[token0Addr] ?? { symbol: token0Addr.slice(0, 8) + "…", decimals: 18 };
    const t1 = KNOWN_TOKENS[token1Addr] ?? { symbol: token1Addr.slice(0, 8) + "…", decimals: 6  };

    // 2. Pool hardcodé (WETH/USDC tickSpacing=100)
    const poolAddr = POOL;

    // 3. Pool state + ticks (parallel)
    const [s0Hex, fg0Hex, fg1Hex, tLowHex, tUpHex] = await Promise.all([
      call(poolAddr, "0x3850c7bd"),
      call(poolAddr, "0xf3058399"),
      call(poolAddr, "0x46141319"),
      call(poolAddr, "0xf30dba93" + pad64(tickLower)),
      call(poolAddr, "0xf30dba93" + pad64(tickUpper)),
    ]);

    const sqrtP    = toUint(word(s0Hex, 0));
    const currTick = Number(toInt(word(s0Hex, 1)));
    const fg0 = toUint(word(fg0Hex, 0));
    const fg1 = toUint(word(fg1Hex, 0));

    // Aerodrome CL ticks() : feeGrowth aux slots 3/4
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

    // 4. Token amounts
    const { a0, a1 } = getAmounts(sqrtP, tickToSqrtX96(tickLower), tickToSqrtX96(tickUpper), liquidity);

    const bal0 = Number(a0) / 10 ** t0.decimals;
    const bal1 = Number(a1) / 10 ** t1.decimals;
    const fee0 = Number(totalOwed0) / 10 ** t0.decimals;
    const fee1 = Number(totalOwed1) / 10 ** t1.decimals;

    const inRange = currTick >= tickLower && currTick < tickUpper;

    // 5. ETH price si pool WETH/USDC
    let ethPrice = null;
    if ((t0.symbol === "WETH" && t1.symbol === "USDC") || (t0.symbol === "USDC" && t1.symbol === "WETH")) {
      ethPrice = Number((sqrtP * sqrtP * 10n ** 12n) / (1n << 192n));
    }

    const usd = (sym, amt) => ethPrice && sym === "WETH" ? amt * ethPrice : sym === "USDC" ? amt : null;

    const poolUsd0 = usd(t0.symbol, bal0);
    const poolUsd1 = usd(t1.symbol, bal1);
    const feeUsd0  = usd(t0.symbol, fee0);
    const feeUsd1  = usd(t1.symbol, fee1);
    const totalPoolUSD = poolUsd0 != null && poolUsd1 != null ? poolUsd0 + poolUsd1 : null;
    const totalFeesUSD = feeUsd0  != null && feeUsd1  != null ? feeUsd0  + feeUsd1  : null;
    const totalUSD     = totalPoolUSD != null && totalFeesUSD != null ? totalPoolUSD + totalFeesUSD : null;

    const payload = {
      protocol: "Aerodrome CL",
      chain: "Base",
      tokenId: POSITION_ID.toString(),
      pair: `${t0.symbol} / ${t1.symbol}`,
      inRange,
      pool: [
        { symbol: t0.symbol, balance: bal0.toFixed(6), usd: poolUsd0?.toFixed(2) ?? null },
        { symbol: t1.symbol, balance: bal1.toFixed(t1.decimals === 6 ? 2 : 6), usd: poolUsd1?.toFixed(2) ?? null },
      ],
      fees: [
        { symbol: t0.symbol, balance: fee0.toFixed(6), usd: feeUsd0?.toFixed(2) ?? null },
        { symbol: t1.symbol, balance: fee1.toFixed(t1.decimals === 6 ? 2 : 6), usd: feeUsd1?.toFixed(2) ?? null },
      ],
      totalPoolUSD: totalPoolUSD?.toFixed(2) ?? null,
      totalFeesUSD: totalFeesUSD?.toFixed(2) ?? null,
      totalUSD: totalUSD?.toFixed(2) ?? null,
      wethPrice: ethPrice?.toFixed(2) ?? null,
    };

    global._cytPos2Cache = { data: payload, time: Date.now() };
    return Response.json(payload);

  } catch (err) {
    if (global._cytPos2Cache.data) return Response.json(global._cytPos2Cache.data);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
