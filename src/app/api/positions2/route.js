import { ethers } from "ethers";

export const runtime     = "nodejs";
export const maxDuration = 30;

// Aerodrome CL — wallet 0xac383af8f62a73a6b156ffa86eb2820bd6a3a2f6
const WALLET = "0xac383af8f62a73a6b156ffa86eb2820bd6a3a2f6";
const NFPM   = "0x827922686190790b37229fd06084350E74485b72";
const POOL   = "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";
const VOTER  = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";

const VOTER_IFACE = new ethers.Interface([
  "function gauges(address pool) view returns (address)",
]);
const GAUGE_IFACE = new ethers.Interface([
  "function stakedValues(address depositor) view returns (uint256[])",
  "function earned(address account, uint256 tokenId) view returns (uint256)",
]);

async function getAeroPrice() {
  try {
    const res  = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=aerodrome-finance&vs_currencies=usd",
      { signal: AbortSignal.timeout(4000) }
    );
    const data = await res.json();
    return data?.["aerodrome-finance"]?.usd ?? 0;
  } catch (_) { return 0; }
}

const TOKENS = {
  "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18 },
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6  },
};

const RPC_URLS = [
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://base.meowrpc.com",
  "https://mainnet.base.org",
];

const CACHE_TTL_MS = 120_000; // 2 minutes
global._cytPos2Cache = { data: null, time: 0 };

// ── RPC — un seul nœud sélectionné par requête ────────────────────────────────

function isRetryable(msg) {
  return /rate.?limit|too many|limit exceed|exceed.*capaci|compute unit|temporary internal|overload|usage.?limit|reached.*limit|upgrade|block range|range.*limit|limited to.*range/i.test(msg);
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

function makeRpc(primaryUrl) {
  const urls = [primaryUrl, ...RPC_URLS.filter(u => u !== primaryUrl)];
  return async (method, params, timeoutMs = 10000) => {
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

// Retourne { tokenIds, gaugeAddr, stakedIds } — gaugeAddr/stakedIds pour les rewards AERO
async function discoverTokenIds(rpc, ethCall) {
  const ids       = new Set();
  let   gaugeAddr = null;
  const stakedIds = [];

  // 0. Positions stakées dans le gauge Aerodrome
  try {
    const gaugeHex = await ethCall(VOTER, VOTER_IFACE.encodeFunctionData("gauges", [POOL])).catch(() => null);
    if (gaugeHex) {
      const [addr] = ethers.AbiCoder.defaultAbiCoder().decode(["address"], gaugeHex);
      if (addr && addr !== ethers.ZeroAddress) {
        gaugeAddr = addr;
        const stakedHex = await ethCall(addr, GAUGE_IFACE.encodeFunctionData("stakedValues", [WALLET])).catch(() => null);
        if (stakedHex && stakedHex !== "0x") {
          const [staked] = GAUGE_IFACE.decodeFunctionResult("stakedValues", stakedHex);
          for (const id of staked) {
            const bigId = BigInt(id);
            ids.add(bigId);
            stakedIds.push(bigId);
          }
        }
      }
    }
  } catch (_) {}

  // 1. NFTs dans le wallet (non stakés)
  const countHex = await ethCall(NFPM, "0x70a08231" + walletPad);
  const count    = Number(toUint(countHex));
  if (count > 0) {
    const walletIds = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        ethCall(NFPM, "0x2f745c59" + walletPad + pad64(i)).then(toUint)
      )
    );
    for (const id of walletIds) ids.add(id);
  }

  if (ids.size > 0) return { tokenIds: [...ids], gaugeAddr, stakedIds };

  // 2. Scan des mints vers ce wallet (~5 mois = 5 M blocs)
  const latestHex = await rpc("eth_blockNumber", []);
  const latest    = Number(BigInt(latestHex));
  const from      = "0x" + Math.max(1, latest - 5_000_000).toString(16);

  const logs = await rpc("eth_getLogs", [{
    address: NFPM,
    topics: [TRANSFER_TOPIC, ZERO_TOPIC, walletTopic],
    fromBlock: from,
    toBlock: "latest",
  }], 20000).catch(() => []);

  if (Array.isArray(logs))
    for (const log of logs) ids.add(BigInt(log.topics[3]));

  return { tokenIds: [...ids], gaugeAddr, stakedIds };
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

const POSITION_OPEN_DATE = new Date("2026-04-30T14:30:00");
const INITIAL_USD        = 142;

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

  const daysElapsed   = (Date.now() - POSITION_OPEN_DATE.getTime()) / 86_400_000;
  const mintDate      = POSITION_OPEN_DATE.toLocaleString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const feeMonthlyPct = ((totalFeesUSD / INITIAL_USD) * (30 / daysElapsed) * 100).toFixed(2);

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
    totalPoolUSD:   totalPoolUSD.toFixed(2),
    totalFeesUSD:   totalFeesUSD.toFixed(2),
    totalUSD:       (totalPoolUSD + totalFeesUSD).toFixed(2),
    wethPrice:      ethPrice.toFixed(2),
    feeMonthlyPct,
    mintDate,
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

    const { tokenIds, gaugeAddr, stakedIds } = await discoverTokenIds(rpc, ethCall);

    if (tokenIds.length === 0) {
      const data = { positions: [] };
      global._cytPos2Cache = { data, time: Date.now() };
      return Response.json(data);
    }

    // Rewards AERO en attente pour les positions stakées
    const aeroUsdById = {};
    if (gaugeAddr && stakedIds.length > 0) {
      const aeroPrice = await getAeroPrice();
      await Promise.allSettled(stakedIds.map(async (tokenId) => {
        try {
          const hex = await ethCall(gaugeAddr, GAUGE_IFACE.encodeFunctionData("earned", [WALLET, tokenId]));
          const [earned] = GAUGE_IFACE.decodeFunctionResult("earned", hex);
          aeroUsdById[tokenId.toString()] = (Number(earned) / 1e18) * aeroPrice;
        } catch (_) {}
      }));
    }

    const results = await Promise.allSettled(tokenIds.map((id) => buildPosition(id, ethCall)));
    const positions = results
      .filter((r) => r.status === "fulfilled" && r.value !== null)
      .map((r) => {
        const pos        = r.value;
        const aeroUSD    = aeroUsdById[pos.tokenId] ?? 0;
        const feesNum    = parseFloat(pos.totalFeesUSD);
        const totalRevUSD = feesNum + aeroUSD;
        const daysElapsed = (Date.now() - POSITION_OPEN_DATE.getTime()) / 86_400_000;
        const totalMonthlyPct = ((totalRevUSD / INITIAL_USD) * (30 / daysElapsed) * 100).toFixed(2);
        return {
          ...pos,
          aeroRevenueUSD:  aeroUSD.toFixed(2),
          totalRevenueUSD: totalRevUSD.toFixed(2),
          totalMonthlyPct,
        };
      });

    const data = { positions };
    global._cytPos2Cache = { data, time: Date.now() };
    return Response.json(data);

  } catch (err) {
    if (global._cytPos2Cache.data) return Response.json(global._cytPos2Cache.data);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
