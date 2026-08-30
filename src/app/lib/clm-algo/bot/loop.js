import { ethers }           from 'ethers';
import { kv }               from '@vercel/kv';
import { neon }             from '@neondatabase/serverless';
import { ALGO_CONFIG, REDIS_KEYS } from '../config.js';
import { readLpState, writeLpState, readP2Range, writeP2Range, getPercentileRange, writePriceAnchor7d, readPriceAnchor7d } from '../../cronKv.js';
import { NFPM_ADDRESS } from '../../config.js';
import { logBotTick }       from './metrics.js';

// Module 7 — Orchestrateur cron pool 2 (stratégie tendance sans short)
// Règles :
//   1.  OOR           → collect AERO + fermer LP + rouvrir (ratio selon tendance)
//   1c. Volatilité ±1.5pt → resserrer/élargir le range (50/50)
//   2.  Aucune pos.   → auto-start LP 50/50
//   3.  En range      → rien

const USDC_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
const RPC_URLS = [
  process.env.ALCHEMY_RPC_URL,
  'https://base.drpc.org',
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
  'https://mainnet.base.org',
].filter(Boolean);

async function readWalletToken(tokenAddress, decimals) {
  const privateKey = process.env.PRIVATE_KEY;
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
  ]);
}

/**
 * Collecte les AERO (pendant que la position est encore stakée), ferme la LP,
 * puis rouvre immédiatement avec tout le capital disponible au ratio de tendance.
 */
async function runCollect(base, price, targetRatio = 0.5) {
  const out = {};

  // Collect AERO avant fermeture — position encore stakée, getReward fonctionne
  for (const step of [1, 2]) {
    try {
      const r = await fetch(`${base}/api/collectFees`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ step, poolNum: 2 }),
        signal:  AbortSignal.timeout(120000),
      });
      out[`step${step}`] = await r.json();
    } catch (e) { out[`step${step}Error`] = e.message; }
  }

  // Fermer la LP
  try   { out.closeLP = await closeLP(base); }
  catch (e) { out.closeLPError = e.message; }

  // Réinitialiser l'état algo
  await clearAlgoState();

  // Rouvrir LP avec tout le capital disponible au ratio cible
  out.autoStart = await autoStart({ base, price, targetRatio });

  // Sauvegarder le nouveau range
  if (out.autoStart?.pool?.tickLowerPrice && out.autoStart?.pool?.tickUpperPrice) {
    await writeP2Range(out.autoStart.pool.tickLowerPrice, out.autoStart.pool.tickUpperPrice);
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
  const rangePct = parseFloat((p24h !== null ? p24h : 10).toFixed(2));
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
      exactBounds:  true,
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

  // 1. État LP + config runtime + timer OOR (en parallèle)
  const [lpState, rtConfig, oorSince] = await Promise.all([
    readLpState(ALGO_CONFIG.POOL_NUM),
    kv.get(REDIS_KEYS.RUNTIME_CONFIG),
    kv.get(REDIS_KEYS.OOR_SINCE),
  ]);
  const hasLP   = !!(lpState && lpState.action2 === null);
  let rMin = hasLP ? parseFloat(lpState.range_min) : null;
  let rMax = hasLP ? parseFloat(lpState.range_max) : null;

  // range_min/max peut être null en DB (pool 2) → lire p2_live_range (mis à jour à chaque page)
  if (hasLP && (rMin == null || isNaN(rMin))) {
    const lr = await readP2Range();
    if (lr?.min) {
      rMin = parseFloat(lr.min);
      rMax = parseFloat(lr.max);
      console.log(`[botLoop] range lu depuis p2_live_range: ${rMin}–${rMax}`);
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
  result.poolNum     = ALGO_CONFIG.POOL_NUM;

  // Règle 1 : hors range → temporiser 10 min avant rebalance (haut et bas)
  if (isOOR) {
    const isOORLow = price < rMin;

    if (!oorSince) {
      await kv.set(REDIS_KEYS.OOR_SINCE, Date.now(), { ex: 30 * 86400 });
      result.action = 'oor_waiting';
      result.oorElapsedMin = 0;
      await logBotTick(kv, result);
      return result;
    }
    const elapsedMin = (Date.now() - Number(oorSince)) / 60000;
    result.oorElapsedMin = parseFloat(elapsedMin.toFixed(1));
    if (elapsedMin < 10) {
      result.action = 'oor_waiting';
      await logBotTick(kv, result);
      return result;
    }

    // Rebalance après 10 min — vérifier cooldown (A) et streak (B)
    const oorDir = isOORLow ? 'low' : 'high';
    const [lastRebTs, streak] = await Promise.all([
      kv.get('p2_last_rebalance_ts').catch(() => null),
      kv.get('p2_oor_streak').catch(() => null),
    ]);

    // A — Cooldown 30 min entre rebalances (anti-chasing immédiat)
    if (lastRebTs) {
      const cooldownMin = (Date.now() - Number(lastRebTs)) / 60000;
      result.cooldownMin = parseFloat(cooldownMin.toFixed(1));
      if (cooldownMin < 30) {
        result.action = 'oor_cooldown';
        await logBotTick(kv, result);
        return result;
      }
    }

    // B — Streak : pause 2h après 2 rebalances consécutifs dans la même direction
    if (streak && streak.direction === oorDir && streak.count >= 2) {
      const streakAgeMin = (Date.now() - Number(streak.lastTs)) / 60000;
      result.streakCount = streak.count;
      result.streakDir   = oorDir;
      if (streakAgeMin < 120) {
        result.action         = 'oor_streak_pause';
        result.streakPauseMin = parseFloat((120 - streakAgeMin).toFixed(1));
        await logBotTick(kv, result);
        return result;
      }
    }

    // Rebalance effectif
    const anchor = await readPriceAnchor7d();
    let targetRatio = 0.5;
    if (anchor) {
      const r = price / anchor;
      if      (r > 1.03) targetRatio = isOORLow ? 0.80 : 0.60;
      else if (r < 0.97) targetRatio = isOORLow ? 0.30 : 0.20;
    }
    result.anchor      = anchor ? parseFloat(anchor) : null;
    result.targetRatio = targetRatio;
    result.action      = 'oor_rebalance';
    result.collect     = await runCollect(base, price, targetRatio);

    // Mise à jour cooldown (A) + streak (B) après rebalance effectif
    const newCount = (streak && streak.direction === oorDir) ? streak.count + 1 : 1;
    await Promise.all([
      kv.set('p2_last_rebalance_ts', Date.now(), { ex: 30 * 86400 }),
      kv.set('p2_oor_streak', { direction: oorDir, count: newCount, lastTs: Date.now() }, { ex: 30 * 86400 }),
    ]);

    await logBotTick(kv, result);
    return result;
  }

  // Prix revenu en range → annuler le timer OOR si actif
  if (oorSince) await kv.del(REDIS_KEYS.OOR_SINCE);

  // Règle 1c : volatilité ±1.5pt → resserrer/élargir le range (50/50)
  if (hasLP && centerPrice && !isNaN(rMin) && !isNaN(rMax)) {
    const pctData = await getPercentileRange();
    const p24h    = pctData && pctData.cnt >= 10 && pctData.p05 > 0
      ? (pctData.p95 - pctData.p05) / pctData.p05 * 100
      : null;
    if (p24h !== null) {
      const rangePctActuel = rtConfig?.rangePct ?? ((rMax - rMin) / rMin * 100);
      const optimalRange   = p24h;
      result.rangePctActuel = parseFloat(rangePctActuel.toFixed(2));
      result.optimalRange   = parseFloat(optimalRange.toFixed(2));
      const p24hAtOpen = rangePctActuel;
      if (p24h < p24hAtOpen - 1.5) {
        console.log(`[botLoop 1c] range_shrink — actuel=${rangePctActuel.toFixed(2)}% optimal=${optimalRange.toFixed(2)}% p24h=${p24h.toFixed(2)}%`);
        result.action  = 'range_shrink_rebalance';
        result.collect = await runCollect(base, price, 0.5);
        await logBotTick(kv, result);
        return result;
      } else if (p24h > p24hAtOpen + 1.5) {
        console.log(`[botLoop 1c] range_expand — actuel=${rangePctActuel.toFixed(2)}% optimal=${optimalRange.toFixed(2)}% p24h=${p24h.toFixed(2)}%`);
        result.action  = 'range_expand_rebalance';
        result.collect = await runCollect(base, price, 0.5);
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
    result.autoStart = await autoStart({ base, price });
    result.action    = result.autoStart.skipped ? 'auto_start_skipped' : 'auto_started';
    await logBotTick(kv, result);
    return result;
  }

  // En range, position active → rien à faire
  result.action = 'in_range_ok';

  await logBotTick(kv, result);
  return result;
}
