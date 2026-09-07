import { ethers }           from 'ethers';
import { kv }               from '@vercel/kv';
import { neon }             from '@neondatabase/serverless';
import { readLpState, writeLpState, readP3Range, writeP3Range, getPercentileRange, writePriceAnchor7d, readPriceAnchor7d, getLastNPrices } from '../../cronKv.js';
import { logBotTick }       from './metrics3.js';

// Module 7bis — Orchestrateur cron pool 3 (copie isolée de loop.js, clés Redis p3_, wallet PRIVATE_KEY_3)
// Règles identiques à pool 2 :
//   1A. OOR 3 ticks consécutifs → fermer LP + swap WETH→USDC (si bas)
//   1B/1U. Zone basse/haute 13/15 ticks → fermer + rouvrir (mean-reversion)
//   1c. Volatilité ±2pt → resserrer/élargir le range (50/50)
//   2.  Aucune pos.   → spread check 20 prix → auto-start
//   3.  En range      → rien

const POOL_NUM     = 3;
const USDC_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
const ERC20_IFACE  = new ethers.Interface(['function transfer(address,uint256) returns (bool)']);
const RPC_URLS = [
  process.env.ALCHEMY_RPC_URL,
  'https://base.drpc.org',
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
  'https://mainnet.base.org',
].filter(Boolean);

// Clés Redis dédiées pool 3 (config locale, ne touche pas config.js ni REDIS_KEYS de pool 2)
const REDIS_KEYS_P3 = {
  POSITION_STATE: 'p3_algo_position_state',
  HEDGE_STATE:    'p3_algo_hedge_state',
  OOR_SINCE:      'p3_algo_oor_since',
  RUNTIME_CONFIG: 'p3_algo_runtime_config',
};

async function readWalletToken(tokenAddress, decimals) {
  const privateKey = process.env.PRIVATE_KEY_3;
  if (!privateKey) return 0;
  const wallet = new ethers.Wallet(privateKey.trim());
  const iface  = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
  const data   = iface.encodeFunctionData('balanceOf', [wallet.address]);
  for (const url of RPC_URLS) {
    try {
      const res  = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: tokenAddress, data }, 'latest'] }),
        signal:  AbortSignal.timeout(6000),
      });
      const json = await res.json();
      if (json.result && json.result !== '0x') {
        const raw = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], json.result)[0];
        return Number(raw) / Math.pow(10, decimals);
      }
    } catch (_) {}
  }
  return 0;
}

const getWalletUsdc = () => readWalletToken(USDC_ADDRESS, 6);
const getWalletWeth = () => readWalletToken(WETH_ADDRESS, 18);

// Verse min(bank, DAILY_CAP) vers DESTINATION_WALLET_3 une fois par jour (Paris TZ)
async function tryDailyTransfer(feesCollectedUsdc = 0) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
  try {
    const [bankRaw, openingTotalRaw, lastTxDate] = await Promise.all([
      kv.get('p3_fees_bank').catch(() => null),
      kv.get('p3_opening_total').catch(() => null),
      kv.get('p3_last_daily_tx').catch(() => null),
    ]);
    const bank     = (parseFloat(bankRaw ?? 0) || 0) + (feesCollectedUsdc || 0);
    const capital  = parseFloat(openingTotalRaw ?? 0) || 0;
    const dailyCap = capital > 0 ? capital * 0.05 / 30 : 0;

    await kv.set('p3_fees_bank', bank, { ex: 604800 });

    if (lastTxDate === today)  return { skipped: 'already_done_today', bank };
    if (dailyCap <= 0 || bank < 0.01) return { skipped: 'insufficient', bank, dailyCap };

    const toSend = parseFloat(Math.min(bank, dailyCap).toFixed(6));
    const dest   = process.env.DESTINATION_WALLET_3;
    if (!dest) return { skipped: 'no_dest_wallet' };

    let txHash = null;
    const amount = ethers.parseUnits(String(toSend), 6);
    for (const url of RPC_URLS) {
      try {
        const provider = new ethers.JsonRpcProvider(url);
        const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY_3.trim(), provider);
        const tx       = await wallet.sendTransaction({
          to:   USDC_ADDRESS,
          data: ERC20_IFACE.encodeFunctionData('transfer', [dest, amount]),
        });
        await tx.wait();
        txHash = tx.hash;
        break;
      } catch (_) {}
    }
    if (!txHash) return { error: 'transfer_failed', bank };

    const bankAfter = parseFloat((bank - toSend).toFixed(6));
    await Promise.all([
      kv.set('p3_fees_bank', bankAfter, { ex: 604800 }),
      kv.set('p3_last_daily_tx', today, { ex: 604800 }),
    ]);

    try {
      const sqlDb = neon(process.env.DATABASE_URL);
      await sqlDb`INSERT INTO dest_transfers (amount_usdc, source, tx_hash, pool_num)
                  VALUES (${toSend}, ${'daily_transfer'}, ${txHash}, ${3})`;
    } catch (_) {}

    return { ok: true, sent: toSend, txHash, bankRemaining: bankAfter, dailyCap };
  } catch (e) {
    return { error: e.message };
  }
}

async function closeLP(base) {
  const res = await fetch(`${base}/api/closePositions`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ keepWeth: true, poolNum: POOL_NUM, caseNum: 9, noTransfer: true }),
    signal:  AbortSignal.timeout(120000),
  });
  return res.json();
}

async function clearAlgoState() {
  await Promise.all([
    kv.del(REDIS_KEYS_P3.POSITION_STATE),
    kv.del(REDIS_KEYS_P3.HEDGE_STATE),
    kv.del(REDIS_KEYS_P3.OOR_SINCE),
    kv.del('p3_edge_streak'),
    kv.del('p3_live_range'),
    kv.del('p3_oor_count'),
    kv.del('p3_oor_low'),
    kv.del('p3_low_zone_hist'),
    kv.del('p3_high_zone_hist'),
  ]);
}

async function closeAndSwap(base, isOORLow) {
  const out = {};

  const usdcBefore = await getWalletUsdc();
  for (const step of [1, 2]) {
    try {
      const r = await fetch(`${base}/api/collectFees`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ step, poolNum: POOL_NUM, noTransfer: true }),
        signal:  AbortSignal.timeout(120000),
      });
      out[`step${step}`] = await r.json();
    } catch (e) { out[`step${step}Error`] = e.message; }
  }
  const feesCollected = Math.max(0, (await getWalletUsdc()) - usdcBefore);
  out.dailyTransfer = await tryDailyTransfer(feesCollected);

  try   { out.closeLP = await closeLP(base); }
  catch (e) { out.closeLPError = e.message; }

  try {
    const r = await fetch(`${base}/api/swap-weth-usdc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ poolNum: POOL_NUM }),
      signal: AbortSignal.timeout(45000),
    });
    out.swapToUsdc = await r.json();
  } catch (e) { out.swapError = e.message; }

  await clearAlgoState();
  return out;
}

/**
 * Collecte les AERO (pendant que la position est encore stakée), ferme la LP,
 * puis rouvre immédiatement avec tout le capital disponible au ratio de tendance.
 */
async function runCollect(base, price, targetRatio = 0.5) {
  const out = {};

  const usdcBefore = await getWalletUsdc();
  for (const step of [1, 2]) {
    try {
      const r = await fetch(`${base}/api/collectFees`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ step, poolNum: POOL_NUM, noTransfer: true }),
        signal:  AbortSignal.timeout(120000),
      });
      out[`step${step}`] = await r.json();
    } catch (e) { out[`step${step}Error`] = e.message; }
  }
  const feesCollected = Math.max(0, (await getWalletUsdc()) - usdcBefore);
  out.dailyTransfer = await tryDailyTransfer(feesCollected);

  try   { out.closeLP = await closeLP(base); }
  catch (e) { out.closeLPError = e.message; }

  await clearAlgoState();

  out.autoStart = await autoStart({ base, price, targetRatio });

  if (out.autoStart?.pool?.tickLowerPrice && out.autoStart?.pool?.tickUpperPrice) {
    await writeP3Range(out.autoStart.pool.tickLowerPrice, out.autoStart.pool.tickUpperPrice, price);
  }

  return out;
}

/**
 * Recrée une position LP avec toute la liquidité disponible au ratio de tendance.
 */
async function autoStart({ base, price, targetRatio = 0.5 }) {
  const result = { action: 'auto_start' };

  const [usdcBal, wethBal] = await Promise.all([getWalletUsdc(), getWalletWeth()]);
  const capital = usdcBal + wethBal * price;
  if (capital < 10) return { ...result, skipped: true, reason: `Capital insuffisant : $${capital.toFixed(2)}` };
  result.capital     = parseFloat(capital.toFixed(2));
  result.targetRatio = targetRatio;

  const pct24h   = await getPercentileRange();
  const p24h     = pct24h && pct24h.cnt >= 10 && pct24h.p05 > 0
    ? (pct24h.p95 - pct24h.p05) / pct24h.p05 * 100
    : null;
  const rangePct = parseFloat((p24h !== null ? Math.ceil(p24h / 0.5) * 0.5 : 10).toFixed(2));
  const halfFrac = rangePct / 200;
  const minPrice = parseFloat((price / (1 + halfFrac)).toFixed(2));
  const maxPrice = parseFloat((price * (1 + halfFrac)).toFixed(2));
  result.rangePct   = rangePct;
  result.percentile = p24h !== null ? parseFloat(p24h.toFixed(2)) : null;

  const poolRes = await fetch(`${base}/api/createPosition`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      amountUSDC:   capital,
      minPrice,
      maxPrice,
      currentPrice: price,
      rangePercent: rangePct,
      targetRatio,
      poolNum:      POOL_NUM,
      exactBounds:  false,
    }),
    signal: AbortSignal.timeout(180000),
  });
  const pool = await poolRes.json();
  if (pool.error) return { ...result, error: `createPosition : ${pool.error}` };
  result.pool = { tickLowerPrice: pool.tickLowerPrice, tickUpperPrice: pool.tickUpperPrice };

  try {
    const swapRes  = await fetch(`${base}/api/swap-weth-usdc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ poolNum: POOL_NUM }),
      signal: AbortSignal.timeout(45000),
    });
    const swapData = await swapRes.json();
    if (swapData.ok && !swapData.skipped) result.wethSwapped = swapData.wethSwapped;
  } catch (_) {}

  const existingAnchor = await readPriceAnchor7d();
  if (!existingAnchor) {
    await writePriceAnchor7d(price);
    result.anchorSet = price;
  }

  const Pa     = pool.tickLowerPrice;
  const Pb     = pool.tickUpperPrice;
  const sqrtPa = Math.sqrt(Pa);
  const sqrtPb = Math.sqrt(Pb);
  const P0_lp  = Math.sqrt(Pa * Pb);
  const L      = capital / (2 * Math.sqrt(P0_lp) - P0_lp / sqrtPb - sqrtPa);

  await kv.set(REDIS_KEYS_P3.RUNTIME_CONFIG, {
    capital, rangePct, liquidityL: L,
    startedAt: new Date().toISOString(),
  }, { ex: 30 * 86400 });
  await kv.del(REDIS_KEYS_P3.POSITION_STATE);
  await kv.del(REDIS_KEYS_P3.HEDGE_STATE);
  await kv.del(REDIS_KEYS_P3.OOR_SINCE);
  await kv.set('p3_hedge_fees', 0, { ex: 30 * 86400 });

  try {
    const openingTotal = parseFloat(capital.toFixed(2));
    await kv.set('p3_opening_total', openingTotal, { ex: 30 * 86400 });
    await kv.set('p3_opening_lp',   openingTotal, { ex: 30 * 86400 });
    result.openingTotal = openingTotal;
    if (process.env.DATABASE_URL && pool.tokenId) {
      const sql = neon(process.env.DATABASE_URL);
      await sql`UPDATE lp_events SET total_at_open = ${openingTotal} WHERE token_id = ${pool.tokenId} AND COALESCE(pool_num, 2) = 3`;
    }
  } catch (_) {}

  return result;
}

/**
 * Point d'entrée principal, appelé depuis cron/route.js — actuellement NON branché.
 */
export async function botLoop3({ base, price }) {
  const result = { price, ts: new Date().toISOString() };

  if (!price) {
    result.skipped = true;
    result.reason  = 'prix indisponible';
    return result;
  }

  const [lpState, rtConfig, oorCountRaw, anchor7dRaw] = await Promise.all([
    readLpState(POOL_NUM),
    kv.get(REDIS_KEYS_P3.RUNTIME_CONFIG),
    kv.get('p3_oor_count').catch(() => null),
    readPriceAnchor7d(),
  ]);

  const anchor7d = anchor7dRaw ? parseFloat(anchor7dRaw) : null;
  let targetRatio = 0.5;
  if (anchor7d) {
    if (price < anchor7d * 0.97)      targetRatio = 0.7;
    else if (price > anchor7d * 1.03) targetRatio = 0.3;
  }
  result.anchor7d    = anchor7d;
  result.targetRatio = targetRatio;
  const hasLP   = !!(lpState && lpState.action2 === null);
  let rMin = hasLP ? parseFloat(lpState.range_min) : null;
  let rMax = hasLP ? parseFloat(lpState.range_max) : null;

  let entryPrice = null;
  if (hasLP) {
    const lr = await readP3Range();
    if (lr?.entry) entryPrice = parseFloat(lr.entry);
    if (rMin == null || isNaN(rMin)) {
      if (lr?.min) {
        rMin = parseFloat(lr.min);
        rMax = parseFloat(lr.max);
        console.log(`[botLoop3] range lu depuis p3_live_range: ${rMin}–${rMax}`);
      }
    }
  }

  const isOOR = hasLP && !isNaN(rMin) && !isNaN(rMax) && (price < rMin || price > rMax);
  const centerPrice = (!isNaN(rMin) && !isNaN(rMax) && rMin > 0 && rMax > 0)
    ? Math.sqrt(rMin * rMax)
    : null;

  result.hasLP       = hasLP;
  result.isOOR       = isOOR;
  result.rMin        = rMin ?? null;
  result.rMax        = rMax ?? null;
  result.centerPrice = centerPrice ? parseFloat(centerPrice.toFixed(2)) : null;
  result.poolNum     = POOL_NUM;

  // Règle 1A : hors range → 3 ticks consécutifs → fermer LP
  if (isOOR) {
    const isOORLow = price < rMin;
    const newCount = (parseInt(oorCountRaw) || 0) + 1;
    await kv.set('p3_oor_count', newCount, { ex: 30 * 86400 });
    await kv.set('p3_oor_low', isOORLow ? 1 : 0, { ex: 30 * 86400 });
    result.oorCount = newCount;
    result.isOORLow = isOORLow;

    if (hasLP) {
      await kv.lpush('p3_low_zone_hist',  isOORLow  ? '1' : '0');
      await kv.ltrim('p3_low_zone_hist',  0, 14);
      await kv.lpush('p3_high_zone_hist', isOORLow  ? '0' : '1');
      await kv.ltrim('p3_high_zone_hist', 0, 14);
    }

    if (newCount < 3) {
      result.action = 'oor_waiting';
      await logBotTick(kv, result);
      return result;
    }

    result.action      = 'oor_close';
    result.closeResult = await closeAndSwap(base, isOORLow);
    await logBotTick(kv, result);
    return result;
  }

  if (oorCountRaw) { await kv.del('p3_oor_count'); await kv.del('p3_oor_low'); }

  // Règle 1B : zone basse (Pa < prix < Pc) — 13/15 ticks → fermer et rouvrir
  if (hasLP && centerPrice && !isNaN(rMin) && !isNaN(rMax)) {
    const Pc = (entryPrice && entryPrice < centerPrice) ? (rMin + entryPrice) / 2 : centerPrice - (rMax - rMin) / 4;
    const inLowZone = price > rMin && price < Pc;
    result.inLowZone = inLowZone;
    result.Pc = parseFloat(Pc.toFixed(2));

    const hist = await kv.lrange('p3_low_zone_hist', 0, 14).catch(() => []);
    const lowZoneHits = hist.filter(v => v === '1' || v === 1).length;
    result.lowZoneHits = lowZoneHits;

    if (lowZoneHits >= 13) {
      const recentPrices = await getLastNPrices(10);
      if (recentPrices.length >= 5) {
        const minP   = Math.min(...recentPrices);
        const maxP   = Math.max(...recentPrices);
        const spread = (maxP - minP) / ((minP + maxP) / 2) * 100;
        result.spreadCheck = parseFloat(spread.toFixed(2));
        if (spread > 1.5) {
          result.action = 'low_zone_spread_skip';
          await logBotTick(kv, result);
          return result;
        }
      }
      result.action  = 'low_zone_rebalance';
      result.collect = await runCollect(base, price, targetRatio);
      await kv.del('p3_low_zone_hist');
      await logBotTick(kv, result);
      return result;
    }

    await kv.lpush('p3_low_zone_hist', inLowZone ? '1' : '0');
    await kv.ltrim('p3_low_zone_hist', 0, 14);
  }

  // Règle 1U : zone haute (Pu < prix < Pb) — 13/15 ticks → fermer et rouvrir
  if (hasLP && centerPrice && !isNaN(rMin) && !isNaN(rMax)) {
    const Pu = (entryPrice && entryPrice > centerPrice) ? (entryPrice + rMax) / 2 : centerPrice + (rMax - rMin) / 4;
    const inUpperZone = price > Pu && price < rMax;
    result.inUpperZone = inUpperZone;
    result.Pu = parseFloat(Pu.toFixed(2));

    const histHigh = await kv.lrange('p3_high_zone_hist', 0, 14).catch(() => []);
    const highZoneHits = histHigh.filter(v => v === '1' || v === 1).length;
    result.highZoneHits = highZoneHits;

    if (highZoneHits >= 13) {
      const recentPrices = await getLastNPrices(10);
      if (recentPrices.length >= 5) {
        const minP   = Math.min(...recentPrices);
        const maxP   = Math.max(...recentPrices);
        const spread = (maxP - minP) / ((minP + maxP) / 2) * 100;
        result.spreadCheckHigh = parseFloat(spread.toFixed(2));
        if (spread > 1.5) {
          result.action = 'high_zone_spread_skip';
          await logBotTick(kv, result);
          return result;
        }
      }
      result.action  = 'high_zone_rebalance';
      result.collect = await runCollect(base, price, targetRatio);
      await kv.del('p3_high_zone_hist');
      await logBotTick(kv, result);
      return result;
    }

    await kv.lpush('p3_high_zone_hist', inUpperZone ? '1' : '0');
    await kv.ltrim('p3_high_zone_hist', 0, 14);
  }

  // Règle 1c : volatilité ±2pt → resserrer/élargir le range (50/50)
  if (hasLP && centerPrice && !isNaN(rMin) && !isNaN(rMax)) {
    const pctData = await getPercentileRange();
    const p24h    = pctData && pctData.cnt >= 10 && pctData.p05 > 0
      ? (pctData.p95 - pctData.p05) / pctData.p05 * 100
      : null;
    if (p24h !== null) {
      const rangePctActuel = (rMax - rMin) / rMin * 100;
      const optimalRange   = p24h;
      result.rangePctActuel = parseFloat(rangePctActuel.toFixed(2));
      result.optimalRange   = parseFloat(optimalRange.toFixed(2));
      const p24hAtOpen = rangePctActuel;
      if (p24h < p24hAtOpen - 1.5) {
        result.action  = 'range_shrink_rebalance';
        result.collect = await runCollect(base, price, targetRatio);
        await logBotTick(kv, result);
        return result;
      } else if (p24h > p24hAtOpen + 1.5) {
        result.action  = 'range_expand_rebalance';
        result.collect = await runCollect(base, price, targetRatio);
        await logBotTick(kv, result);
        return result;
      }
    }
  }

  // Règle 2 : aucune position → auto-start
  if (!hasLP) {
    try {
      const sqlCheck = neon(process.env.DATABASE_URL);
      const dbRows = await sqlCheck`
        SELECT * FROM lp_events
        WHERE action1 = 'CREATE_OK' AND action2 IS NULL AND token_id IS NOT NULL
          AND COALESCE(pool_num, 2) = ${POOL_NUM}
        ORDER BY id DESC LIMIT 1
      `;
      if (dbRows[0]?.token_id) {
        await writeLpState(POOL_NUM, dbRows[0]);
        result.action = 'redis_restored';
        await logBotTick(kv, result);
        return result;
      }
    } catch (_) {}

    const recentPrices = await getLastNPrices(20);
    if (recentPrices.length >= 10) {
      const minP   = Math.min(...recentPrices);
      const maxP   = Math.max(...recentPrices);
      const mid    = (minP + maxP) / 2;
      const spread = (maxP - minP) / mid * 100;
      result.spread = parseFloat(spread.toFixed(2));
      if (spread > 1.5) {
        result.action = 'auto_start_spread_skip';
        await logBotTick(kv, result);
        return result;
      }
    }

    result.autoStart = await autoStart({ base, price, targetRatio });
    result.action    = result.autoStart.skipped ? 'auto_start_skipped' : 'auto_started';
    await logBotTick(kv, result);
    return result;
  }

  result.action = 'in_range_ok';

  await logBotTick(kv, result);
  return result;
}
