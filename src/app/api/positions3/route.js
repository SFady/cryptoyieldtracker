export const runtime     = "nodejs";
export const maxDuration = 30;

// Aerodrome CL — USDC/cbBTC — wallet 0xaf96ca0b19b3966105bf2f28a05c10d586692499
const WALLET  = "0xaf96ca0b19b3966105bf2f28a05c10d586692499";
const NFPM    = "0x827922686190790b37229fd06084350E74485b72";
const POOL    = "0x4e962bb3889bf030368f56810a9c96b83cb3e778";

const USDC_ADDR  = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const CBBTC_ADDR = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";

const TOKENS = {
  [USDC_ADDR]:  { symbol: "USDC",  decimals: 6 },
  [CBBTC_ADDR]: { symbol: "cbBTC", decimals: 8 },
};

const RPC_URLS = [
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://base.meowrpc.com",
  "https://mainnet.base.org",
];

const CACHE_TTL_MS = 120_000;

global._cytPos3Cache2 = global._cytPos3Cache2 ?? { data: null, time: 0 };
global._pos3ActiveId2 = global._pos3ActiveId2 ?? { id: null, time: 0 };

// ── RPC ───────────────────────────────────────────────────────────────────────

function isRetryable(msg) {
  return /rate.?limit|too many|limit exceed|exceed.*capaci|compute unit|temporary internal|overload|usage.?limit|reached.*limit|upgrade|block range|range.*limit|limited to.*range/i.test(msg);
}

async function rpcFetch(urls, method, params, timeoutMs = 8000) {
  let lastErr;
  for (const url of urls) {
    try {
      const res  = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (!text) { lastErr = new Error("empty response"); continue; }
      const json = JSON.parse(text);
      if (json.error) {
        const msg = json.error.message ?? "";
        if (isRetryable(msg)) { lastErr = new Error(msg); continue; }
        throw new Error(msg);
      }
      return json.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error("Aucun RPC disponible");
}

async function pickRpc() {
  return new Promise((resolve) => {
    let done = false;
    let pending = RPC_URLS.length;
    for (const url of RPC_URLS) {
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        signal: AbortSignal.timeout(4000),
      })
        .then(r => r.json())
        .then(json => { if (!done && json.result) { done = true; resolve(url); } })
        .catch(() => {})
        .finally(() => { if (--pending === 0 && !done) resolve(RPC_URLS[0]); });
    }
  });
}

function makeCall(primaryUrl) {
  const urls = [primaryUrl, ...RPC_URLS.filter(u => u !== primaryUrl)];
  return (to, data) => rpcFetch(urls, "eth_call", [{ to, data }, "latest"]);
}

async function getLogs(primaryUrl, params) {
  const urls = [primaryUrl, ...RPC_URLS.filter(u => u !== primaryUrl)];
  return rpcFetch(urls, "eth_getLogs", params, 15000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const M256 = 1n << 256n;
function pad64(n) { return (((BigInt(n) % M256) + M256) % M256).toString(16).padStart(64, "0"); }
function word(h, i) { const s = h.startsWith("0x") ? h.slice(2) : h; return s.slice(i * 64, (i + 1) * 64); }
function toUint(w) { if (!w || w === "0x") return 0n; const s = w.startsWith("0x") ? w.slice(2) : w; return s ? BigInt("0x" + s) : 0n; }
function toInt(w)  { const n = toUint(w); return n >= M256 / 2n ? n - M256 : n; }
function toAddr(w) { return "0x" + w.slice(24).toLowerCase(); }
function mod256(n) { return ((n % M256) + M256) % M256; }

const walletPad   = WALLET.slice(2).toLowerCase().padStart(64, "0");
const walletTopic = "0x000000000000000000000000" + WALLET.slice(2).toLowerCase();
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC     = "0x0000000000000000000000000000000000000000000000000000000000000000";

// ── Rebalance detection ───────────────────────────────────────────────────────

async function scanActiveId(rpcUrl, call) {
  // 1. NFTs directement dans le wallet — toutes les positions en parallèle
  const countHex = await call(NFPM, "0x70a08231" + walletPad);
  const count    = Number(toUint(countHex));
  if (count > 0) {
    const ids = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        call(NFPM, "0x2f745c59" + walletPad + pad64(i)).then(toUint)
      )
    );
    const hexes = await Promise.all(ids.map(id =>
      call(NFPM, "0x99fbab88" + pad64(id)).catch(() => null)
    ));
    for (let i = 0; i < ids.length; i++) {
      const h = hexes[i];
      if (!h) continue;
      if (toAddr(word(h, 2)) === USDC_ADDR && toAddr(word(h, 3)) === CBBTC_ADDR && toUint(word(h, 7)) > 0n)
        return ids[i];
    }
  }

  // 2. Scan des mints vers le wallet (5 derniers mois)
  const latestHex = await rpcFetch(
    [rpcUrl, ...RPC_URLS.filter(u => u !== rpcUrl)],
    "eth_blockNumber", [], 5000
  );
  const latest = Number(BigInt(latestHex));
  const from   = "0x" + Math.max(1, latest - 5_000_000).toString(16);

  const logs = await getLogs(rpcUrl, [{
    address: NFPM,
    topics: [TRANSFER_TOPIC, ZERO_TOPIC, walletTopic],
    fromBlock: from, toBlock: "latest",
  }]).catch(() => []);

  const ids = logs.map(l => BigInt(l.topics[3])).reverse();
  for (const id of ids) {
    const posHex = await call(NFPM, "0x99fbab88" + pad64(id)).catch(() => null);
    if (!posHex) continue;
    const t0 = toAddr(word(posHex, 2));
    const t1 = toAddr(word(posHex, 3));
    if (t0 !== USDC_ADDR || t1 !== CBBTC_ADDR) continue;
    const liq = toUint(word(posHex, 7));
    if (liq > 0n) return id;
  }
  return null;
}

// ── CL math ───────────────────────────────────────────────────────────────────

function tickToSqrtX96(tick) {
  return BigInt(Math.round(Math.exp(Number(tick) * Math.log(1.0001) / 2) * 2 ** 96));
}
function getAmounts(sqrtP, sqrtA, sqrtB, liq) {
  const Q96 = 1n << 96n;
  if (sqrtP <= sqrtA) return { a0: (liq * Q96 * (sqrtB - sqrtA)) / (sqrtA * sqrtB), a1: 0n };
  if (sqrtP >= sqrtB) return { a0: 0n, a1: (liq * (sqrtB - sqrtA)) / Q96 };
  return { a0: (liq * Q96 * (sqrtB - sqrtP)) / (sqrtP * sqrtB), a1: (liq * (sqrtP - sqrtA)) / Q96 };
}
function calcFees(liq, fgInside, fgInsideLast, owed) {
  const Q128 = 1n << 128n;
  const delta = mod256(fgInside - fgInsideLast);
  if (delta > (1n << 200n)) return owed;
  return owed + (liq * delta) / Q128;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET() {
  const c = global._cytPos3Cache2;
  if (c.data && Date.now() - c.time < CACHE_TTL_MS) return Response.json(c.data);

  try {
    const rpcUrl = await pickRpc();
    const call   = makeCall(rpcUrl);

    let tokenId = global._pos3ActiveId2.id;

    if (!tokenId) {
      tokenId = await scanActiveId(rpcUrl, call).catch(() => null);
      if (tokenId) global._pos3ActiveId2 = { id: tokenId, time: Date.now() };
    }

    if (!tokenId) {
      const data = { positions: [] };
      global._cytPos3Cache2 = { data, time: Date.now() };
      return Response.json(data);
    }

    let posHex = await call(NFPM, "0x99fbab88" + pad64(tokenId));
    const pairOk = toAddr(word(posHex, 2)) === USDC_ADDR && toAddr(word(posHex, 3)) === CBBTC_ADDR;
    const liquidity  = toUint(word(posHex, 7));
    const owed0check = toUint(word(posHex, 10));
    const owed1check = toUint(word(posHex, 11));

    if (!pairOk || (liquidity === 0n && owed0check === 0n && owed1check === 0n)) {
      const newId = await scanActiveId(rpcUrl, call).catch(() => null);
      if (newId) {
        tokenId = newId;
        global._pos3ActiveId2 = { id: newId, time: Date.now() };
        posHex = await call(NFPM, "0x99fbab88" + pad64(tokenId));
      } else {
        const data = { positions: [] };
        global._cytPos3Cache2 = { data, time: Date.now() };
        return Response.json(data);
      }
    }

    const pHex = posHex;

    const t0addr    = toAddr(word(pHex, 2));
    const t1addr    = toAddr(word(pHex, 3));
    const tickLower = Number(toInt(word(pHex, 5)));
    const tickUpper = Number(toInt(word(pHex, 6)));
    const liq       = toUint(word(pHex, 7));
    const fgLast0   = toUint(word(pHex, 8));
    const fgLast1   = toUint(word(pHex, 9));
    const owed0     = toUint(word(pHex, 10));
    const owed1     = toUint(word(pHex, 11));

    const t0 = TOKENS[t0addr] ?? { symbol: "TK0", decimals: 6 };
    const t1 = TOKENS[t1addr] ?? { symbol: "TK1", decimals: 8 };

    const [s0Hex, fg0Hex, fg1Hex, tLowHex, tUpHex] = await Promise.all([
      call(POOL, "0x3850c7bd"),
      call(POOL, "0xf3058399"),
      call(POOL, "0x46141319"),
      call(POOL, "0xf30dba93" + pad64(tickLower)),
      call(POOL, "0xf30dba93" + pad64(tickUpper)),
    ]);

    const sqrtP    = toUint(word(s0Hex, 0));
    const currTick = Number(toInt(word(s0Hex, 1)));
    const fg0      = toUint(word(fg0Hex, 0));
    const fg1      = toUint(word(fg1Hex, 0));
    const fgLow0   = toUint(word(tLowHex, 3));
    const fgLow1   = toUint(word(tLowHex, 4));
    const fgUp0    = toUint(word(tUpHex, 3));
    const fgUp1    = toUint(word(tUpHex, 4));

    const fgBelow0  = currTick >= tickLower ? fgLow0 : mod256(fg0 - fgLow0);
    const fgBelow1  = currTick >= tickLower ? fgLow1 : mod256(fg1 - fgLow1);
    const fgAbove0  = currTick < tickUpper  ? fgUp0  : mod256(fg0 - fgUp0);
    const fgAbove1  = currTick < tickUpper  ? fgUp1  : mod256(fg1 - fgUp1);
    const fgInside0 = mod256(fg0 - fgBelow0 - fgAbove0);
    const fgInside1 = mod256(fg1 - fgBelow1 - fgAbove1);

    const totalOwed0 = calcFees(liq, fgInside0, fgLast0, owed0);
    const totalOwed1 = calcFees(liq, fgInside1, fgLast1, owed1);

    const { a0, a1 } = getAmounts(sqrtP, tickToSqrtX96(tickLower), tickToSqrtX96(tickUpper), liq);
    const bal0 = Number(a0) / 10 ** t0.decimals;
    const bal1 = Number(a1) / 10 ** t1.decimals;
    const fee0 = Number(totalOwed0) / 10 ** t0.decimals;
    const fee1 = Number(totalOwed1) / 10 ** t1.decimals;
    const inRange = currTick >= tickLower && currTick < tickUpper;

    // Prix BTC depuis sqrtPriceX96 (token0=USDC d=6, token1=cbBTC d=8)
    const btcPrice = Number((100n * (1n << 192n)) / (sqrtP * sqrtP));
    const usd = (sym, amt) => sym === "cbBTC" ? amt * btcPrice : amt;

    const poolUsd0 = usd(t0.symbol, bal0);
    const poolUsd1 = usd(t1.symbol, bal1);
    const feeUsd0  = usd(t0.symbol, fee0);
    const feeUsd1  = usd(t1.symbol, fee1);
    const totalPoolUSD = poolUsd0 + poolUsd1;
    const totalFeesUSD = feeUsd0  + feeUsd1;

    const payload = {
      protocol: "Aerodrome CL", chain: "Base",
      tokenId: tokenId.toString(),
      pair: `${t0.symbol} / ${t1.symbol}`,
      inRange,
      pool: [
        { symbol: t0.symbol, balance: bal0.toFixed(2), usd: poolUsd0.toFixed(2) },
        { symbol: t1.symbol, balance: bal1.toFixed(8), usd: poolUsd1.toFixed(2) },
      ],
      fees: [
        { symbol: t0.symbol, balance: fee0.toFixed(2), usd: feeUsd0.toFixed(2) },
        { symbol: t1.symbol, balance: fee1.toFixed(8), usd: feeUsd1.toFixed(2) },
      ],
      totalPoolUSD: totalPoolUSD.toFixed(2),
      totalFeesUSD: totalFeesUSD.toFixed(2),
      totalUSD:     (totalPoolUSD + totalFeesUSD).toFixed(2),
      btcPrice:     btcPrice.toFixed(2),
    };

    const data = { positions: [payload] };
    global._cytPos3Cache2 = { data, time: Date.now() };
    return Response.json(data);

  } catch (err) {
    console.error("positions3 error:", err.message);
    if (global._cytPos3Cache2.data) return Response.json(global._cytPos3Cache2.data);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
