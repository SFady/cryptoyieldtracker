import { ethers } from "ethers";
import { neon }   from "@neondatabase/serverless";

export const runtime     = "nodejs";
export const maxDuration = 30;

// Aerodrome CL — WETH/USDC — pool 3 (wallet depuis env WALLET_ADDRESS_3)
const WALLET = (process.env.WALLET_ADDRESS_3 ?? "").toLowerCase();
const NFPM   = "0x827922686190790b37229fd06084350E74485b72";
const POOL   = "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";
const VOTER  = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";
const USDC   = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

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
  process.env.ALCHEMY_RPC_URL,
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
].filter(Boolean);

const CACHE_TTL_MS = 120_000;
global._cytPos3Cache = global._cytPos3Cache ?? { data: null, time: 0 };

// ── RPC ───────────────────────────────────────────────────────────────────────

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

function getWalletPads() {
  if (!WALLET || WALLET.length < 40) return { walletPad: "0".repeat(64), walletTopic: "0x" + "0".repeat(64) };
  const addr = WALLET.startsWith("0x") ? WALLET.slice(2) : WALLET;
  return {
    walletPad:   addr.toLowerCase().padStart(64, "0"),
    walletTopic: "0x000000000000000000000000" + addr.toLowerCase(),
  };
}

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC     = "0x0000000000000000000000000000000000000000000000000000000000000000";

// ── Découverte des tokenIds ───────────────────────────────────────────────────

async function discoverTokenIds(rpc, ethCall) {
  const { walletPad, walletTopic } = getWalletPads();
  const ids       = new Set();
  let   gaugeAddr = null;
  const stakedIds = [];

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

  if (liquidity === 0n && owed0 === 0n && owed1 === 0n) return null;

  const t0 = TOKENS[token0Addr] ?? { symbol: "TK0", decimals: 18 };
  const t1 = TOKENS[token1Addr] ?? { symbol: "TK1", decimals: 6  };

  const [s0Hex, fg0Hex, fg1Hex, tickLoHex, tickHiHex] = await Promise.all([
    ethCall(POOL, "0x3850c7bd"),
    ethCall(POOL, POOL_IFACE.encodeFunctionData("feeGrowthGlobal0X128")).catch(() => null),
    ethCall(POOL, POOL_IFACE.encodeFunctionData("feeGrowthGlobal1X128")).catch(() => null),
    ethCall(POOL, POOL_IFACE.encodeFunctionData("ticks", [tickLower])).catch(() => null),
    ethCall(POOL, POOL_IFACE.encodeFunctionData("ticks", [tickUpper])).catch(() => null),
  ]);

  const sqrtP    = toUint(word(s0Hex, 0));
  const currTick = Number(toInt(word(s0Hex, 1)));

  const { a0, a1 } = getAmounts(sqrtP, tickToSqrtX96(tickLower), tickToSqrtX96(tickUpper), liquidity);

  const bal0 = Number(a0) / 10 ** t0.decimals;
  const bal1 = Number(a1) / 10 ** t1.decimals;
  const inRange = currTick >= tickLower && currTick < tickUpper;

  let fee0 = Number(owed0) / 10 ** t0.decimals;
  let fee1 = Number(owed1) / 10 ** t1.decimals;
  try {
    const sub256   = (a, b) => mod256(a - b);
    const [fg0]    = POOL_IFACE.decodeFunctionResult("feeGrowthGlobal0X128", fg0Hex);
    const [fg1]    = POOL_IFACE.decodeFunctionResult("feeGrowthGlobal1X128", fg1Hex);
    const tickLo   = POOL_IFACE.decodeFunctionResult("ticks", tickLoHex);
    const tickHi   = POOL_IFACE.decodeFunctionResult("ticks", tickHiHex);

    const fgGlobal0 = BigInt(fg0);
    const fgGlobal1 = BigInt(fg1);
    const fgOutLo0  = BigInt(tickLo.feeGrowthOutside0X128);
    const fgOutLo1  = BigInt(tickLo.feeGrowthOutside1X128);
    const fgOutHi0  = BigInt(tickHi.feeGrowthOutside0X128);
    const fgOutHi1  = BigInt(tickHi.feeGrowthOutside1X128);

    const fgBelow0  = currTick >= tickLower ? fgOutLo0 : sub256(fgGlobal0, fgOutLo0);
    const fgBelow1  = currTick >= tickLower ? fgOutLo1 : sub256(fgGlobal1, fgOutLo1);
    const fgAbove0  = currTick <  tickUpper ? fgOutHi0 : sub256(fgGlobal0, fgOutHi0);
    const fgAbove1  = currTick <  tickUpper ? fgOutHi1 : sub256(fgGlobal1, fgOutHi1);

    const fgInside0 = sub256(sub256(fgGlobal0, fgBelow0), fgAbove0);
    const fgInside1 = sub256(sub256(fgGlobal1, fgBelow1), fgAbove1);

    const Q128      = 1n << 128n;
    const pending0  = (liquidity * sub256(fgInside0, fgInside0Last)) / Q128 + owed0;
    const pending1  = (liquidity * sub256(fgInside1, fgInside1Last)) / Q128 + owed1;

    fee0 = Number(pending0) / 10 ** t0.decimals;
    fee1 = Number(pending1) / 10 ** t1.decimals;
  } catch (_) {}

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
  const c = global._cytPos3Cache;
  if (c.data && Date.now() - c.time < CACHE_TTL_MS) return Response.json(c.data);

  if (!WALLET) {
    return Response.json({ positions: [], error: "WALLET_ADDRESS_3 non configuré" });
  }

  try {
    const rpcUrl  = await pickRpc();
    const rpc     = makeRpc(rpcUrl);
    const ethCall = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);

    let fastTokenId = null;
    try {
      const rows = await sql`
        SELECT token_id FROM lp_events
        WHERE action1 = 'CREATE_OK' AND action2 IS NULL AND token_id IS NOT NULL
          AND pool_num = 3
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
        if (liq === 0n && ow0 === 0n && ow1 === 0n) fastTokenId = null;
      } catch (_) {}
    }

    let tokenIds, gaugeAddr, stakedIds;
    if (fastTokenId) {
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
      const { walletPad } = getWalletPads();
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
      } catch (_) {}
      const data = { positions: [], usdcWallet, wethWallet, wethWalletUSD };
      global._cytPos3Cache = { data, time: Date.now() };
      return Response.json(data);
    }

    const aeroUsdById = {};
    const aeroBalById = {};
    if (gaugeAddr && stakedIds.length > 0) {
      const aeroPrice = await getAeroPrice();
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

    const openDataByTokenId = {};
    try {
      const rows = await sql`
        SELECT DISTINCT ON (token_id) token_id, created_at, usdc_placed
        FROM lp_events
        WHERE action1 = 'CREATE_OK' AND pool_num = 3 AND token_id = ANY(${tokenIds.map(id => id.toString())})
        ORDER BY token_id, created_at ASC
      `;
      for (const row of rows) {
        openDataByTokenId[row.token_id] = {
          openDate:   new Date(row.created_at),
          initialUSD: row.usdc_placed ? parseFloat(row.usdc_placed) : null,
        };
      }
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
          aeroRevenueUSD:  aeroUSD.toFixed(2),
          aeroBalance:     aeroBal > 0 ? aeroBal.toFixed(2) : "",
          totalRevenueUSD: totalRevUSD.toFixed(2),
        };
      });

    if (results.length > 0 && results.every(r => r.status === "rejected"))
      throw new Error(results[0].reason?.message ?? "RPC indisponible");

    const { walletPad } = getWalletPads();
    let usdcWallet = "0.00";
    let wethWallet = "0.00";
    let wethWalletUSD = "0.00";
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
      const wethPriceNum = parseFloat(positions[0]?.wethPrice ?? "0");
      if (wethPriceNum > 0) wethWalletUSD = (wethAmt * wethPriceNum).toFixed(2);
    } catch (_) {}

    let percentileRangePct = null;
    try {
      const pRows = await sql`
        SELECT
          PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY weth) AS p05,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY weth) AS p95,
          COUNT(*)::int AS cnt
        FROM cron_runs
        WHERE weth IS NOT NULL
          AND ran_at > NOW() - INTERVAL '24 hours'
      `;
      const { p05, p95, cnt } = pRows[0];
      if (cnt >= 10 && p05 > 0)
        percentileRangePct = parseFloat(((p95 - p05) / p05 * 100).toFixed(2));
    } catch (_) {}

    let nextCronAt = null;
    try {
      const cronRows = await sql`SELECT MAX(ran_at) AS last FROM cron_runs`;
      if (cronRows[0]?.last) {
        const next = new Date(cronRows[0].last);
        next.setMinutes(next.getMinutes() + 30);
        nextCronAt = next.toISOString();
      }
    } catch (_) {}

    let transferHistory = [];
    try {
      const tRows = await sql`
        SELECT created_at, amount_usdc, source, tx_hash
        FROM dest_transfers
        WHERE pool_num = 3
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

    const data = { positions, usdcWallet, wethWallet, wethWalletUSD, percentileRangePct, transferHistory, nextCronAt };
    global._cytPos3Cache = { data, time: Date.now() };
    return Response.json(data);

  } catch (err) {
    if (global._cytPos3Cache.data) return Response.json(global._cytPos3Cache.data);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
