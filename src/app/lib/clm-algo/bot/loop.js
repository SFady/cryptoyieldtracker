import { ethers }           from 'ethers';
import { kv }               from '@vercel/kv';
import { neon }             from '@neondatabase/serverless';
import { ALGO_CONFIG, REDIS_KEYS } from '../config.js';
import { readLpState, writeLpState, readP2Range, writeP2Range, getPercentileRange, writePriceAnchor7d, readPriceAnchor7d, getLastNPrices } from '../../cronKv.js';
import { NFPM_ADDRESS } from '../../config.js';
import { logBotTick }       from './metrics.js';

// Module 7 — Orchestrateur cron pool 2 (stratégie 50/50)
// Règles :
//   1A. Zone de bord (5% du range, englobe OOR) 5 ticks consécutifs → fermer LP
//   1c. Volatilité ±1.5pt → resserrer/élargir le range (50/50)
//   2.  Aucune pos.   → spread check 20 prix → auto-start
//   3.  En range      → rien

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

// pinnedUrl : force la même source RPC pour des lectures avant/après censées être
// comparables (sinon deux nœuds légèrement désynchronisés faussent la différence).
async function readWalletToken(tokenAddress, decimals, pinnedUrl = null) {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) return 0;
  const wallet = new ethers.Wallet(privateKey.trim());
  const iface  = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
  const data   = iface.encodeFunctionData('balanceOf', [wallet.address]);
  for (const url of (pinnedUrl ? [pinnedUrl] : RPC_URLS)) {
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

const getWalletUsdc = (pinnedUrl) => readWalletToken(USDC_ADDRESS, 6, pinnedUrl);
const getWalletWeth = (pinnedUrl) => readWalletToken(WETH_ADDRESS, 18, pinnedUrl);

// Trouve un RPC qui répond, à réutiliser pour toutes les lectures d'un même cycle
async function pickWorkingRpc() {
  for (const url of RPC_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
        signal: AbortSignal.timeout(6000),
      });
      const json = await res.json();
      if (json.result) return url;
    } catch (_) {}
  }
  return RPC_URLS[0];
}

// Verse une fraction des AERO déjà convertis en USDC vers DESTINATION_WALLET.
// Règle 1A (sortie directionnelle) : haut → 50% envoyés/50% gardés ; bas → 25%/75%.
// Règle 1c (resserrement/élargissement, pas de direction) : toujours 25%/75% (isLow=true).
async function sendAeroSplit(feesCollectedUsdc, isLow) {
  if (!feesCollectedUsdc || feesCollectedUsdc < 0.01) return { skipped: 'insufficient', feesCollectedUsdc };

  const fraction = isLow ? 0.25 : 0.5;
  const toSend   = parseFloat((feesCollectedUsdc * fraction).toFixed(6));
  const dest     = process.env.DESTINATION_WALLET;
  if (!dest) return { skipped: 'no_dest_wallet' };

  let txHash = null;
  const amount = ethers.parseUnits(String(toSend), 6);
  for (const url of RPC_URLS) {
    try {
      const provider = new ethers.JsonRpcProvider(url);
      const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY.trim(), provider);
      const tx       = await wallet.sendTransaction({
        to:   USDC_ADDRESS,
        data: ERC20_IFACE.encodeFunctionData('transfer', [dest, amount]),
      });
      await tx.wait();
      txHash = tx.hash;
      break;
    } catch (_) {}
  }
  if (!txHash) return { error: 'transfer_failed', toSend };

  try {
    const sqlDb = neon(process.env.DATABASE_URL);
    await sqlDb`INSERT INTO dest_transfers (amount_usdc, source, tx_hash, pool_num)
                VALUES (${toSend}, ${isLow ? 'edge_low_25pct' : 'edge_high_50pct'}, ${txHash}, ${2})`;
  } catch (_) {}

  return { ok: true, sent: toSend, kept: parseFloat((feesCollectedUsdc - toSend).toFixed(6)), txHash, side: isLow ? 'low' : 'high', fraction };
}

async function closeLP(base) {
  const res = await fetch(`${base}/api/closePositions`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ keepWeth: true, poolNum: ALGO_CONFIG.POOL_NUM, caseNum: 9, noTransfer: true }),
    signal:  AbortSignal.timeout(120000),
  });
  return res.json();
}

async function clearAlgoState() {
  await Promise.all([
    kv.del(REDIS_KEYS.POSITION_STATE),
    kv.del(REDIS_KEYS.HEDGE_STATE),
    kv.del(REDIS_KEYS.OOR_SINCE),
    kv.del('p2_edge_streak'),
    kv.del('p2_live_range'),
    kv.del('p2_oor_count'),
    kv.del('p2_oor_low'),
  ]);
}

async function closeEdgeZone(base, isLow) {
  const out = {};

  const rpcUrl    = await pickWorkingRpc();
  const usdcBefore = await getWalletUsdc(rpcUrl);
  for (const step of [1, 2]) {
    try {
      const r = await fetch(`${base}/api/collectFees`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ step, poolNum: 2, noTransfer: true }),
        signal:  AbortSignal.timeout(120000),
      });
      out[`step${step}`] = await r.json();
    } catch (e) { out[`step${step}Error`] = e.message; }
  }
  const feesCollected = Math.max(0, (await getWalletUsdc(rpcUrl)) - usdcBefore);
  out.aeroSplit = await sendAeroSplit(feesCollected, isLow);

  try   { out.closeLP = await closeLP(base); }
  catch (e) { out.closeLPError = e.message; }

  await clearAlgoState();
  return out;
}

/**
 * Collecte les AERO (pendant que la position est encore stakée), ferme la LP,
 * puis rouvre immédiatement avec tout le capital disponible au ratio de tendance.
 */
async function runCollect(base, price, targetRatio = 0.5) {
  const out = {};

  // Collect AERO avant fermeture — position encore stakée, getReward fonctionne
  const rpcUrl     = await pickWorkingRpc();
  const usdcBefore = await getWalletUsdc(rpcUrl);
  for (const step of [1, 2]) {
    try {
      const r = await fetch(`${base}/api/collectFees`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ step, poolNum: 2, noTransfer: true }),
        signal:  AbortSignal.timeout(120000),
      });
      out[`step${step}`] = await r.json();
    } catch (e) { out[`step${step}Error`] = e.message; }
  }
  const feesCollected = Math.max(0, (await getWalletUsdc(rpcUrl)) - usdcBefore);
  out.aeroSplit = await sendAeroSplit(feesCollected, true); // Règle 1c : toujours 25%/75%

  // Fermer la LP
  try   { out.closeLP = await closeLP(base); }
  catch (e) { out.closeLPError = e.message; }

  // Réinitialiser l'état algo
  await clearAlgoState();

  // Rouvrir LP avec tout le capital disponible au ratio cible
  out.autoStart = await autoStart({ base, price, targetRatio });

  // Sauvegarder le nouveau range
  if (out.autoStart?.pool?.tickLowerPrice && out.autoStart?.pool?.tickUpperPrice) {
    await writeP2Range(out.autoStart.pool.tickLowerPrice, out.autoStart.pool.tickUpperPrice, price);
  }

  return out;
}

/**
 * Recrée une position LP avec toute la liquidité disponible au ratio de tendance.
 */
async function autoStart({ base, price, targetRatio = 0.5 }) {
  const result = { action: 'auto_start' };

  // 1. Capital disponible = USDC + WETH dans le wallet
  const [usdcBal, wethBal] = await Promise.all([getWalletUsdc(), getWalletWeth()]);
  const capital = usdcBal + wethBal * price;
  if (capital < 10) return { ...result, skipped: true, reason: `Capital insuffisant : $${capital.toFixed(2)}` };
  result.capital     = parseFloat(capital.toFixed(2));
  result.targetRatio = targetRatio;

  // 2. Range dynamique = 1 × percentile 24h (min 2%, fallback 10%)
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

  // 3. Créer la LP au ratio cible
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
      poolNum:      ALGO_CONFIG.POOL_NUM,
      exactBounds:  false,
    }),
    signal: AbortSignal.timeout(180000),
  });
  const pool = await poolRes.json();
  if (pool.error) return { ...result, error: `createPosition : ${pool.error}` };
  result.pool = { tickLowerPrice: pool.tickLowerPrice, tickUpperPrice: pool.tickUpperPrice };

  // Convertir le WETH résiduel en USDC
  try {
    const swapRes  = await fetch(`${base}/api/swap-weth-usdc`, { method: 'POST', signal: AbortSignal.timeout(45000) });
    const swapData = await swapRes.json();
    if (swapData.ok && !swapData.skipped) result.wethSwapped = swapData.wethSwapped;
  } catch (_) {}

  // 4. Initialiser ancre de tendance si absente (8j TTL → auto-reset)
  const existingAnchor = await readPriceAnchor7d();
  if (!existingAnchor) {
    await writePriceAnchor7d(price);
    result.anchorSet = price;
  }

  // 5. Sauvegarder la config runtime (sans short)
  const Pa     = pool.tickLowerPrice;
  const Pb     = pool.tickUpperPrice;
  const sqrtPa = Math.sqrt(Pa);
  const sqrtPb = Math.sqrt(Pb);
  const P0_lp  = Math.sqrt(Pa * Pb);
  const L      = capital / (2 * Math.sqrt(P0_lp) - P0_lp / sqrtPb - sqrtPa);

  await kv.set(REDIS_KEYS.RUNTIME_CONFIG, {
    capital, rangePct, liquidityL: L,
    startedAt: new Date().toISOString(),
  }, { ex: 30 * 86400 });
  await kv.del(REDIS_KEYS.POSITION_STATE);
  await kv.del(REDIS_KEYS.HEDGE_STATE);
  await kv.del(REDIS_KEYS.OOR_SINCE);
  await kv.set('p2_hedge_fees', 0, { ex: 30 * 86400 });

  // 6. Total au démarrage (Redis + Neon)
  try {
    const openingTotal = parseFloat(capital.toFixed(2));
    await kv.set('p2_opening_total', openingTotal, { ex: 30 * 86400 });
    await kv.set('p2_opening_lp',   openingTotal, { ex: 30 * 86400 });
    result.openingTotal = openingTotal;
    if (process.env.DATABASE_URL && pool.tokenId) {
      const sql = neon(process.env.DATABASE_URL);
      await sql`UPDATE lp_events SET total_at_open = ${openingTotal} WHERE token_id = ${pool.tokenId} AND COALESCE(pool_num, 2) = 2`;
    }
  } catch (_) {}

  return result;
}

/**
 * Point d'entrée principal, appelé depuis cron/route.js.
 */
export async function botLoop({ base, price }) {
  const result = { price, ts: new Date().toISOString() };

  if (!price) {
    result.skipped = true;
    result.reason  = 'prix indisponible';
    return result;
  }

  // 1. État LP + config runtime + compteur OOR (en parallèle)
  const [lpState, rtConfig, oorCountRaw, anchor7dRaw] = await Promise.all([
    readLpState(ALGO_CONFIG.POOL_NUM),
    kv.get(REDIS_KEYS.RUNTIME_CONFIG),
    kv.get('p2_oor_count').catch(() => null),
    readPriceAnchor7d(),
  ]);

  const anchor7d = anchor7dRaw ? parseFloat(anchor7dRaw) : null;
  let targetRatio = 0.5;
  if (anchor7d) {
    if (price < anchor7d * 0.97)      targetRatio = 0.7; // baissier → mean reversion haussière
    else if (price > anchor7d * 1.03) targetRatio = 0.3; // haussier → mean reversion baissière
  }
  result.anchor7d    = anchor7d;
  result.targetRatio = targetRatio;
  const hasLP   = !!(lpState && lpState.action2 === null);
  let rMin = hasLP ? parseFloat(lpState.range_min) : null;
  let rMax = hasLP ? parseFloat(lpState.range_max) : null;

  // Lire p2_live_range : range réel (fallback si absent de lpState)
  if (hasLP) {
    const lr = await readP2Range();
    if (rMin == null || isNaN(rMin)) {
      if (lr?.min) {
        rMin = parseFloat(lr.min);
        rMax = parseFloat(lr.max);
        console.log(`[botLoop] range lu depuis p2_live_range: ${rMin}–${rMax}`);
      }
    }
  }

  // Zone de bord = 5% du range total de chaque côté (englobe aussi l'OOR complet,
  // qui n'est qu'un cas particulier de "prix au-delà de rMin/rMax")
  const edgeMargin = (!isNaN(rMin) && !isNaN(rMax)) ? (rMax - rMin) * 0.05 : null;
  const isOOR = hasLP && edgeMargin !== null && (price < rMin + edgeMargin || price > rMax - edgeMargin);
  const centerPrice = (!isNaN(rMin) && !isNaN(rMax) && rMin > 0 && rMax > 0)
    ? Math.sqrt(rMin * rMax)
    : null;

  result.hasLP       = hasLP;
  result.isOOR       = isOOR;
  result.rMin        = rMin ?? null;
  result.rMax        = rMax ?? null;
  result.centerPrice = centerPrice ? parseFloat(centerPrice.toFixed(2)) : null;
  result.poolNum     = ALGO_CONFIG.POOL_NUM;

  // Règle 1A : zone de bord (5% du range) — 5 ticks consécutifs → fermer LP
  if (isOOR) {
    const isOORLow = price < rMin + edgeMargin;
    const newCount = (parseInt(oorCountRaw) || 0) + 1;
    await kv.set('p2_oor_count', newCount, { ex: 30 * 86400 });
    await kv.set('p2_oor_low', isOORLow ? 1 : 0, { ex: 30 * 86400 });
    result.oorCount = newCount;
    result.isOORLow = isOORLow;

    if (newCount < 5) {
      result.action = 'oor_waiting';
      await logBotTick(kv, result);
      return result;
    }

    // 5 ticks consécutifs en zone de bord → fermer LP + split AERO vers wallet externe
    result.action      = 'oor_close';
    result.closeResult = await closeEdgeZone(base, isOORLow);
    await logBotTick(kv, result);
    return result;
  }

  // Prix revenu en range → reset compteur OOR
  if (oorCountRaw) { await kv.del('p2_oor_count'); await kv.del('p2_oor_low'); }

  // Règle 1c : volatilité ±1.5pt → resserrer/élargir le range (50/50)
  // Uniquement si le prix est proche du centre (±5% du range total) — évite de resizer
  // quand le prix est déjà proche d'un bord, où la Règle 1A est plus appropriée.
  const centerMargin = (!isNaN(rMin) && !isNaN(rMax)) ? (rMax - rMin) * 0.05 : null;
  const nearCenter    = centerPrice !== null && centerMargin !== null && Math.abs(price - centerPrice) <= centerMargin;
  result.nearCenter1c = hasLP ? nearCenter : null;
  if (hasLP && centerPrice && nearCenter && !isNaN(rMin) && !isNaN(rMax)) {
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
        console.log(`[botLoop 1c] range_shrink — actuel=${rangePctActuel.toFixed(2)}% optimal=${optimalRange.toFixed(2)}% p24h=${p24h.toFixed(2)}%`);
        result.action  = 'range_shrink_rebalance';
        result.collect = await runCollect(base, price, targetRatio);
        await logBotTick(kv, result);
        return result;
      } else if (p24h > p24hAtOpen + 1.5) {
        console.log(`[botLoop 1c] range_expand — actuel=${rangePctActuel.toFixed(2)}% optimal=${optimalRange.toFixed(2)}% p24h=${p24h.toFixed(2)}%`);
        result.action  = 'range_expand_rebalance';
        result.collect = await runCollect(base, price, targetRatio);
        await logBotTick(kv, result);
        return result;
      }
    }
  }

  // Règle 2 : aucune position → auto-start
  if (!hasLP) {
    // Vérifier si Redis est désynchronisé (position active en DB, Redis dit CLOSE_OK)
    try {
      const sqlCheck = neon(process.env.DATABASE_URL);
      const dbRows = await sqlCheck`
        SELECT * FROM lp_events
        WHERE action1 = 'CREATE_OK' AND action2 IS NULL AND token_id IS NOT NULL
          AND COALESCE(pool_num, 2) = ${ALGO_CONFIG.POOL_NUM}
        ORDER BY id DESC LIMIT 1
      `;
      if (dbRows[0]?.token_id) {
        await writeLpState(ALGO_CONFIG.POOL_NUM, dbRows[0]);
        result.action = 'redis_restored';
        await logBotTick(kv, result);
        return result;
      }
    } catch (_) {}

    // Spread check : marché trop agité → attendre
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

  // En range, position active → rien à faire
  result.action = 'in_range_ok';

  await logBotTick(kv, result);
  return result;
}
