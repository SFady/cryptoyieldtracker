import { ethers } from "ethers";
import { neon }   from "@neondatabase/serverless";
import { getLastTwoPrices, getPercentileRange, getNextCronAt, readPositionsCache, writePositionsCache } from "../../lib/cronKv";
import { POOL_ADDRESS_2 as POOL } from "../../lib/config";

export const runtime     = "nodejs";
export const maxDuration = 30;

// Aerodrome CL — wallet 0xac383af8f62a73a6b156ffa86eb2820bd6a3a2f6
const WALLET      = "0xac383af8f62a73a6b156ffa86eb2820bd6a3a2f6";
const walletShort = WALLET.slice(0, 6) + "…" + WALLET.slice(-3);
const NFPM   = "0xe1f8cd9ac4e4a65f54f38a5cdafca44f6dd68b53"; // NFPM_NEW (Slipstream v2)
const VOTER  = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";
const USDC       = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const AERO       = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const V2_ROUTER  = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const V2_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";

const VOTER_IFACE = new ethers.Interface([
  "function gauges(address pool) view returns (address)",
]);
const GAUGE_IFACE = new ethers.Interface([
  "function stakedValues(address depositor) view returns (uint256[])",
  "function earned(address account, uint256 tokenId) view returns (uint256)",
]);
const V2_ROUTER_IFACE = new ethers.Interface([
  "function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)",
]);

async function getAeroPrice(ethCall) {
  try {
    const routes  = [{ from: AERO, to: USDC, stable: false, factory: V2_FACTORY }];
    const amtsHex = await ethCall(V2_ROUTER, V2_ROUTER_IFACE.encodeFunctionData("getAmountsOut", [ethers.parseUnits("1", 18), routes]));
    const [amounts] = V2_ROUTER_IFACE.decodeFunctionResult("getAmountsOut", amtsHex);
    return parseFloat(ethers.formatUnits(amounts[1], 6));
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
  "https://mainnet.base.org",
];

global._cytPos2Cache = { data: null };

// ── RPC — un seul nœud sélectionné par requête ────────────────────────────────

function isRetryable(msg) {
  return /rate.?limit|too many|limit exceed|exceed.*capaci|compute unit|temporary internal|overload|usage.?limit|reached.*limit|upgrade|block range|range.*limit|limited to.*range|method.*not.?support|not supported/i.test(msg);
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


const sql = neon(process.env.DATABASE_URL);

const POOL_IFACE = new ethers.Interface([
  "function feeGrowthGlobal0X128() view returns (uint256)",
  "function feeGrowthGlobal1X128() view returns (uint256)",
  "function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet, int128 stakedLiquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, uint256 rewardGrowthOutsideX128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)",
]);

// ── Calcul d'une position ─────────────────────────────────────────────────────

async function buildPosition(tokenId, ethCall, openData) {
  const posHex = await ethCall(NFPM, "0x99fbab88" + pad64(tokenId));

  const token0Addr    = toAddr(word(posHex, 2));
  const token1Addr    = toAddr(word(posHex, 3));
  const tickLower     = Number(toInt(word(posHex, 5)));
  const tickUpper     = Number(toInt(word(posHex, 6)));
  const liquidity     = toUint(word(posHex, 7));
  const fgInside0Last = toUint(word(posHex, 8));
  const fgInside1Last = toUint(word(posHex, 9));
  const owed0         = toUint(word(posHex, 10));
  const owed1         = toUint(word(posHex, 11));

  if (liquidity === 0n && owed0 === 0n && owed1 === 0n) return null; // position fermée

  const t0 = TOKENS[token0Addr] ?? { symbol: "TK0", decimals: 18 };
  const t1 = TOKENS[token1Addr] ?? { symbol: "TK1", decimals: 6  };

  const [s0Hex] = await Promise.all([
    ethCall(POOL, "0x3850c7bd"),
  ]);

  const sqrtP    = toUint(word(s0Hex, 0));
  const currTick = Number(toInt(word(s0Hex, 1)));

  const { a0, a1 } = getAmounts(sqrtP, tickToSqrtX96(tickLower), tickToSqrtX96(tickUpper), liquidity);

  const bal0 = Number(a0) / 10 ** t0.decimals;
  const bal1 = Number(a1) / 10 ** t1.decimals;
  const inRange = currTick >= tickLower && currTick < tickUpper;

  // Position stakée dans CLGauge Aerodrome : les fees WETH/USDC vont au feesVotingReward
  // (voteurs veAERO), pas à l'LP via NFPM. On n'affiche rien de collectible ici.
  const fee0 = 0;
  const fee1 = 0;

  const ethPrice = Number((sqrtP * sqrtP * 10n ** 12n) / (1n << 192n));
  const usd = (sym, amt) => sym === "WETH" ? amt * ethPrice : amt;

  const poolUsd0 = usd(t0.symbol, bal0);
  const poolUsd1 = usd(t1.symbol, bal1);
  const feeUsd0  = usd(t0.symbol, fee0);
  const feeUsd1  = usd(t1.symbol, fee1);
  const totalPoolUSD = poolUsd0 + poolUsd1;
  const totalFeesUSD = feeUsd0  + feeUsd1;

  const openDate   = openData?.openDate ?? new Date();
  const initialUSD = openData?.initialUSD ?? null;
  const mintDate   = openDate.toLocaleString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });

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
    rangePct:       ((1.0001 ** (tickUpper - tickLower) - 1) * 100).toFixed(1),
    rangeLow:       (1.0001 ** tickLower * 1e12).toFixed(0),
    rangeHigh:      (1.0001 ** tickUpper * 1e12).toFixed(0),
    wethPrice:      ethPrice.toFixed(2),
    mintDate,
    openTimestamp: openDate.getTime(),
    initialUSD,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET() {
  const cached = await readPositionsCache(2);
  if (cached) {
    const cronWeth = await getLastTwoPrices();
    return Response.json({ ...cached, cronWeth });
  }

  try {
    // Un seul RPC pour toute la requête → données cohérentes (même bloc)
    const rpcUrl  = await pickRpc();
    const rpc     = makeRpc(rpcUrl);
    const ethCall = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);

    // DB first — évite le scan RPC multi-appels sous rate limit
    let fastTokenId = null;
    try {
      const rows = await sql`
        SELECT token_id FROM lp_events
        WHERE action1 = 'CREATE_OK' AND action2 IS NULL AND token_id IS NOT NULL
          AND COALESCE(pool_num, 2) = 2
        ORDER BY id DESC LIMIT 1
      `;
      if (rows.length > 0 && rows[0].token_id) fastTokenId = BigInt(rows[0].token_id);
    } catch (_) {}

    if (fastTokenId) {
      try {
        const posHex = await ethCall(NFPM, "0x99fbab88" + pad64(fastTokenId));
        const liq = toUint(word(posHex, 7));
        const ow0 = toUint(word(posHex, 10));
        const ow1 = toUint(word(posHex, 11));
        // Seulement si confirmé fermé on-chain on abandonne le tokenId
        if (liq === 0n && ow0 === 0n && ow1 === 0n) fastTokenId = null;
      } catch (_) { /* RPC failure ≠ position fermée — on garde fastTokenId */ }
    }

    let tokenIds, gaugeAddr, stakedIds;
    if (fastTokenId) {
      // Position connue via DB → gauge scan minimal pour les rewards AERO uniquement
      tokenIds  = [fastTokenId];
      gaugeAddr = null;
      stakedIds = [];
      try {
        const gaugeHex = await ethCall(VOTER, VOTER_IFACE.encodeFunctionData("gauges", [POOL])).catch(() => null);
        if (gaugeHex) {
          const [addr] = ethers.AbiCoder.defaultAbiCoder().decode(["address"], gaugeHex);
          if (addr && addr !== ethers.ZeroAddress) {
            gaugeAddr = addr;
            const stakedHex = await ethCall(addr, GAUGE_IFACE.encodeFunctionData("stakedValues", [WALLET])).catch(() => null);
            if (stakedHex && stakedHex !== "0x") {
              const [staked] = GAUGE_IFACE.decodeFunctionResult("stakedValues", stakedHex);
              for (const id of staked) stakedIds.push(BigInt(id));
            }
          }
        }
      } catch (_) {}
    } else {
      ({ tokenIds, gaugeAddr, stakedIds } = await discoverTokenIds(rpc, ethCall));
    }

    if (tokenIds.length === 0) {
      const walletPad = WALLET.slice(2).toLowerCase().padStart(64, "0");
      let usdcWallet = "0.00", wethWallet = "0.00", wethWalletUSD = "0.00";
      try {
        const hex = await ethCall(USDC, "0x70a08231" + walletPad);
        const [raw] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], hex);
        usdcWallet = Number(ethers.formatUnits(raw, 6)).toFixed(2);
      } catch (_) {}
      try {
        const WETH = "0x4200000000000000000000000000000000000006";
        const hex = await ethCall(WETH, "0x70a08231" + walletPad);
        const [raw] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], hex);
        const wethAmt = Number(ethers.formatUnits(raw, 18));
        wethWallet = wethAmt.toFixed(6);
        try {
          const slot0Hex = await ethCall(POOL, "0x3850c7bd");
          const [sqrtPX96] = ethers.AbiCoder.defaultAbiCoder().decode(["uint160"], slot0Hex);
          const wethPriceNum = Number((sqrtPX96 * sqrtPX96 * 10n ** 12n) / (1n << 192n));
          if (wethPriceNum > 0) wethWalletUSD = (wethAmt * wethPriceNum).toFixed(2);
        } catch (_) {}
      } catch (_) {}
      const data = { positions: [], usdcWallet, wethWallet, wethWalletUSD, walletShort };
      global._cytPos2Cache = { data };
      await writePositionsCache(2, data);
      return Response.json(data);
    }

    // Rewards AERO en attente pour les positions stakées
    const aeroUsdById = {};
    const aeroBalById = {};
    if (gaugeAddr && stakedIds.length > 0) {
      const aeroPrice = await getAeroPrice(ethCall);
      await Promise.allSettled(stakedIds.map(async (tokenId) => {
        try {
          const hex = await ethCall(gaugeAddr, GAUGE_IFACE.encodeFunctionData("earned", [WALLET, tokenId]));
          const [earned] = GAUGE_IFACE.decodeFunctionResult("earned", hex);
          const aeroAmt = Number(earned) / 1e18;
          aeroUsdById[tokenId.toString()] = aeroAmt * aeroPrice;
          aeroBalById[tokenId.toString()] = aeroAmt;
        } catch (_) {}
      }));
    }

    // Dates et montants initiaux depuis lp_events
    const openDataByTokenId = {};
    try {
      const rows = await sql`
        SELECT DISTINCT ON (token_id) token_id, created_at, usdc_placed
        FROM lp_events
        WHERE action1 = 'CREATE_OK' AND token_id = ANY(${tokenIds.map(id => id.toString())})
        ORDER BY token_id, created_at ASC
      `;
      for (const row of rows) {
        openDataByTokenId[row.token_id] = {
          openDate:   new Date(row.created_at),
          initialUSD: row.usdc_placed ? parseFloat(row.usdc_placed) : null,
        };
      }
    } catch (_) {}

    let lastCollectTimestamp = null;
    try {
      const collectRows = await sql`
        SELECT created_at FROM lp_events
        WHERE action1 = 'FEE_COLLECT' AND action2 IS NULL AND COALESCE(pool_num, 2) = 2
        ORDER BY created_at DESC LIMIT 1
      `;
      if (collectRows.length > 0) lastCollectTimestamp = new Date(collectRows[0].created_at).getTime();
    } catch (_) {}

    const results = await Promise.allSettled(tokenIds.map((id) => buildPosition(id, ethCall, openDataByTokenId[id.toString()])));
    const positions = results
      .filter((r) => r.status === "fulfilled" && r.value !== null)
      .map((r) => {
        const pos         = r.value;
        const aeroUSD     = aeroUsdById[pos.tokenId] ?? 0;
        const aeroBal     = aeroBalById[pos.tokenId] ?? 0;
        const feesNum     = parseFloat(pos.totalFeesUSD);
        const totalRevUSD = feesNum + aeroUSD;
        return {
          ...pos,
          aeroRevenueUSD:       aeroUSD.toFixed(2),
          aeroBalance:          aeroBal > 0 ? aeroBal.toFixed(2) : "",
          totalRevenueUSD:      totalRevUSD.toFixed(2),
          lastCollectTimestamp,
        };
      });

    // Si toutes les buildPosition ont échoué (RPC) → ne pas empoisonner le cache
    if (results.length > 0 && results.every(r => r.status === "rejected"))
      throw new Error(results[0].reason?.message ?? "RPC indisponible");

    // Solde USDC + WETH non utilisé dans le wallet
    let usdcWallet = "0.00";
    let wethWallet = "0.00";
    try {
      const hex = await ethCall(USDC, "0x70a08231" + WALLET.slice(2).padStart(64, "0"));
      const [raw] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], hex);
      usdcWallet = Number(ethers.formatUnits(raw, 6)).toFixed(2);
    } catch (_) {}
    let wethWalletUSD = "0.00";
    try {
      const WETH = "0x4200000000000000000000000000000000000006";
      const hex = await ethCall(WETH, "0x70a08231" + WALLET.slice(2).padStart(64, "0"));
      const [raw] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], hex);
      const wethAmt = Number(ethers.formatUnits(raw, 18));
      wethWallet = wethAmt.toFixed(6);
      let wethPriceNum = parseFloat(positions[0]?.wethPrice ?? "0");
      if (wethPriceNum === 0) {
        try {
          const slot0Hex = await ethCall(POOL, "0x3850c7bd");
          const [sqrtPX96] = ethers.AbiCoder.defaultAbiCoder().decode(["uint160"], slot0Hex);
          wethPriceNum = Number((sqrtPX96 * sqrtPX96 * 10n ** 12n) / (1n << 192n));
        } catch (_) {}
      }
      if (wethPriceNum > 0) wethWalletUSD = (wethAmt * wethPriceNum).toFixed(2);
    } catch (_) {}

    // Range percentile 5%–95% sur les 24h dernières
    let percentileRangePct = null;
    try {
      const pct = await getPercentileRange();
      if (pct && pct.cnt >= 10 && pct.p05 > 0)
        percentileRangePct = parseFloat(((pct.p95 - pct.p05) / pct.p05 * 100).toFixed(2));
    } catch (_) {}

    // Historique des envois vers DESTINATION_WALLET
    let transferHistory = [];
    try {
      const tRows = await sql`
        SELECT created_at, amount_usdc, source, tx_hash
        FROM dest_transfers
        WHERE COALESCE(pool_num, 2) = 2
        ORDER BY created_at DESC
        LIMIT 20
      `;
      transferHistory = tRows.map(r => ({
        date:   new Date(r.created_at).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }),
        amount: parseFloat(r.amount_usdc).toFixed(2),
        source: r.source,
        txHash: r.tx_hash,
      }));
    } catch (_) {}

    const nextCronAt = await getNextCronAt();
    const cronWeth   = await getLastTwoPrices();

    const data = { positions, usdcWallet, wethWallet, wethWalletUSD, percentileRangePct, transferHistory, nextCronAt, cronWeth, walletShort };
    global._cytPos2Cache = { data };
    await writePositionsCache(2, data);
    return Response.json(data);

  } catch (err) {
    if (global._cytPos2Cache.data) return Response.json(global._cytPos2Cache.data);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
