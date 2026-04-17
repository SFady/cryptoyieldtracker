export const runtime     = "nodejs";
export const maxDuration = 30;

// Aerodrome CL — wallet 0xac383af8f62a73a6b156ffa86eb2820bd6a3a2f6
const WALLET = "0xac383af8f62a73a6b156ffa86eb2820bd6a3a2f6";
const NFPM   = "0x827922686190790b37229fd06084350E74485b72";
const POOL   = "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";

const TOKENS = {
  "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18 },
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6  },
};

const RPC_URLS = [
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://mainnet.base.org",
  "https://base.gateway.tenderly.co",
  "https://1rpc.io/base",
];

const CACHE_TTL_MS = 120_000; // 2 minutes
global._cytPos2Cache = { data: null, time: 0 };

// ── RPC — un seul nœud sélectionné par requête ────────────────────────────────

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

function makeRpc(rpcUrl) {
  return async (method, params) => {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(6000),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const M256 = 1n << 256n;
function pad64(n) { return (((BigInt(n) % M256) + M256) % M256).toString(16).padStart(64, "0"); }
function word(h, i) { const s = h.startsWith("0x") ? h.slice(2) : h; return s.slice(i * 64, (i + 1) * 64); }
function toUint(w) { if (!w || w === "0x") return 0n; const s = w.startsWith("0x") ? w.slice(2) : w; return s ? BigInt("0x" + s) : 0n; }
function toInt(w)  { const n = toUint(w); return n >= M256 / 2n ? n - M256 : n; }
function toAddr(w) { return "0x" + w.slice(24).toLowerCase(); }
function mod256(n) { return ((n % M256) + M256) % M256; }

const walletPad  = WALLET.slice(2).toLowerCase().padStart(64, "0");
const walletTopic = "0x000000000000000000000000" + WALLET.slice(2).toLowerCase();
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC     = "0x0000000000000000000000000000000000000000000000000000000000000000";

// ── Découverte des tokenIds ───────────────────────────────────────────────────

// rpc et ethCall sont injectés par le handler pour garantir un seul nœud
async function discoverTokenIds(rpc, ethCall) {
  // 1. Le NFT est dans le wallet (non staké)
  const countHex = await ethCall(NFPM, "0x70a08231" + walletPad);
  const count = Number(toUint(countHex));

  if (count > 0) {
    const ids = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        ethCall(NFPM, "0x2f745c59" + walletPad + pad64(i)).then(toUint)
      )
    );
    return ids;
  }

  // 2. Fallback : scan des mints récents vers ce wallet (~1 jour = 54 000 blocs)
  const latestHex = await rpc("eth_blockNumber", []);
  const latest = Number(BigInt(latestHex));
  const LOOKBACK = 54_000;
  const CHUNK    = 9_000;
  const from     = Math.max(0, latest - LOOKBACK);

  const ranges = [];
  for (let s = from; s < latest; s += CHUNK)
    ranges.push({ f: s, t: Math.min(s + CHUNK - 1, latest) });

  const ids = new Set();
  await Promise.all(
    ranges.map(({ f, t }) =>
      rpc("eth_getLogs", [{
        address: NFPM,
        topics: [TRANSFER_TOPIC, ZERO_TOPIC, walletTopic], // mint → wallet
        fromBlock: "0x" + f.toString(16),
        toBlock:   "0x" + t.toString(16),
      }]).then((logs) => {
        if (Array.isArray(logs))
          for (const log of logs) ids.add(BigInt(log.topics[3]));
      }).catch(() => {})
    )
  );

  return [...ids];
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
  const delta = mod256(fgInside - fgInsideLast);
  // Si delta > 2^200, la soustraction a débordé (fgInside < fgInsideLast) → pas de nouveaux frais
  if (delta > (1n << 200n)) return owed;
  return owed + (liq * delta) / Q128;
}

// ── Calcul d'une position ─────────────────────────────────────────────────────

async function buildPosition(tokenId, ethCall) {
  const posHex = await ethCall(NFPM, "0x99fbab88" + pad64(tokenId));

  const token0Addr    = toAddr(word(posHex, 2));
  const token1Addr    = toAddr(word(posHex, 3));
  const tickLower     = Number(toInt(word(posHex, 5)));
  const tickUpper     = Number(toInt(word(posHex, 6)));
  const liquidity     = toUint(word(posHex, 7));
  const fgInsideLast0 = toUint(word(posHex, 8));
  const fgInsideLast1 = toUint(word(posHex, 9));
  const owed0         = toUint(word(posHex, 10));
  const owed1         = toUint(word(posHex, 11));

  if (liquidity === 0n && owed0 === 0n && owed1 === 0n) return null; // position fermée

  const t0 = TOKENS[token0Addr] ?? { symbol: "TK0", decimals: 18 };
  const t1 = TOKENS[token1Addr] ?? { symbol: "TK1", decimals: 6  };

  const [s0Hex, fg0Hex, fg1Hex, tLowHex, tUpHex] = await Promise.all([
    ethCall(POOL, "0x3850c7bd"),
    ethCall(POOL, "0xf3058399"),
    ethCall(POOL, "0x46141319"),
    ethCall(POOL, "0xf30dba93" + pad64(tickLower)),
    ethCall(POOL, "0xf30dba93" + pad64(tickUpper)),
  ]);

  const sqrtP    = toUint(word(s0Hex, 0));
  const currTick = Number(toInt(word(s0Hex, 1)));
  const fg0 = toUint(word(fg0Hex, 0));
  const fg1 = toUint(word(fg1Hex, 0));

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

  const raw0 = calcFees(liquidity, fgInside0, fgInsideLast0, owed0);
  const raw1 = calcFees(liquidity, fgInside1, fgInsideLast1, owed1);

  const { a0, a1 } = getAmounts(sqrtP, tickToSqrtX96(tickLower), tickToSqrtX96(tickUpper), liquidity);

  const bal0 = Number(a0) / 10 ** t0.decimals;
  const bal1 = Number(a1) / 10 ** t1.decimals;
  const fee0 = Number(raw0) / 10 ** t0.decimals;
  const fee1 = Number(raw1) / 10 ** t1.decimals;
  const inRange = currTick >= tickLower && currTick < tickUpper;

  const ethPrice = Number((sqrtP * sqrtP * 10n ** 12n) / (1n << 192n));
  const usd = (sym, amt) => sym === "WETH" ? amt * ethPrice : amt;

  const poolUsd0 = usd(t0.symbol, bal0);
  const poolUsd1 = usd(t1.symbol, bal1);
  const feeUsd0  = usd(t0.symbol, fee0);
  const feeUsd1  = usd(t1.symbol, fee1);
  const totalPoolUSD = poolUsd0 + poolUsd1;
  const totalFeesUSD = feeUsd0  + feeUsd1;

  return {
    protocol: "Aerodrome CL",
    chain: "Base",
    tokenId: tokenId.toString(),
    pair: `${t0.symbol} / ${t1.symbol}`,
    inRange,
    pool: [
      { symbol: t0.symbol, balance: bal0.toFixed(6),  usd: poolUsd0.toFixed(2) },
      { symbol: t1.symbol, balance: bal1.toFixed(2),  usd: poolUsd1.toFixed(2) },
    ],
    fees: [
      { symbol: t0.symbol, balance: fee0.toFixed(6),  usd: feeUsd0.toFixed(2)  },
      { symbol: t1.symbol, balance: fee1.toFixed(2),  usd: feeUsd1.toFixed(2)  },
    ],
    totalPoolUSD: totalPoolUSD.toFixed(2),
    totalFeesUSD: totalFeesUSD.toFixed(2),
    totalUSD:     (totalPoolUSD + totalFeesUSD).toFixed(2),
    wethPrice:    ethPrice.toFixed(2),
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET() {
  const c = global._cytPos2Cache;
  if (c.data && Date.now() - c.time < CACHE_TTL_MS) return Response.json(c.data);

  try {
    // Un seul RPC pour toute la requête → données cohérentes (même bloc)
    const rpcUrl  = await pickRpc();
    const rpc     = makeRpc(rpcUrl);
    const ethCall = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);

    const tokenIds = await discoverTokenIds(rpc, ethCall);

    if (tokenIds.length === 0) {
      const data = { positions: [] };
      global._cytPos2Cache = { data, time: Date.now() };
      return Response.json(data);
    }

    const results = await Promise.allSettled(tokenIds.map((id) => buildPosition(id, ethCall)));
    const positions = results
      .filter((r) => r.status === "fulfilled" && r.value !== null)
      .map((r) => r.value);

    const data = { positions };
    global._cytPos2Cache = { data, time: Date.now() };
    return Response.json(data);

  } catch (err) {
    if (global._cytPos2Cache.data) return Response.json(global._cytPos2Cache.data);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
