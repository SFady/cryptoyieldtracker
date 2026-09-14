import { ethers }           from 'ethers';
import { kv }               from '@vercel/kv';
import { neon }             from '@neondatabase/serverless';
import { ALGO_CONFIG, REDIS_KEYS } from '../config.js';
import { readLpState, writeLpState, readP2Range, writeP2Range, getPercentileRange, getPriceAverage14d, getPriceAverage24h, getLastNPrices } from '../../cronKv.js';
import { NFPM_ADDRESS } from '../../config.js';
import { logBotTick }       from './metrics.js';

// Module 7 — Orchestrateur cron pool 2
// Règles :
//   1A. Zone de bord (5% du range, englobe OOR) 5 ticks consécutifs → fermer LP
//   1c. Volatilité ±1.5pt (si revenus ≥ AERO) → resserrer/élargir le range (ratio dynamique MM14j × MM24h)
//   1d. Tendance changée depuis ≥6h (si revenus ≥ AERO) → resserrer/élargir le range (ratio dynamique MM14j × MM24h)
//   2.  Aucune pos.   → spread check 20 prix → auto-start (ratio dynamique MM14j × MM24h)
//   3.  En range      → rien

// Lettre de tendance vs une moyenne mobile : H (haussier, prix > MM×1.01), B (baissier, prix < MM×0.99), N (neutre/incertain)
function trendLetter(price, avg) {
  if (!price || avg == null) return 'N';
  if (price > avg * 1.01) return 'H';
  if (price < avg * 0.99) return 'B';
  return 'N';
}

// Ratio WETH de réouverture selon tendance MM14j × MM24h (grille 3×3)
const REOPEN_RATIO_GRID = {
  H: { H: 0.8, N: 0.7, B: 0.6 },
  N: { H: 0.6, N: 0.5, B: 0.4 },
  B: { H: 0.4, N: 0.3, B: 0.2 },
};
function reopenRatioFromTrends(t14, t24) {
  return REOPEN_RATIO_GRID[t14]?.[t24] ?? 0.5;
}

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

async function closeLP(base, keepWeth = true, closeReason = null, feesUsdc = null, aeroSplitFraction = null) {
  const res = await fetch(`${base}/api/closePositions`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ keepWeth, poolNum: ALGO_CONFIG.POOL_NUM, caseNum: 9, noTransfer: true, closeReason, feesUsdc, aeroSplitFraction }),
    signal:  AbortSignal.timeout(120000),
  });
  return res.json();
}

// Total revenus (pool + AERO + solde wallet − capital déployé) et part AERO de ce total,
// mêmes formules que l'affichage "Total revenus" / badge AERO sur la page pools.
async function getRevenueGate(base) {
  try {
    const r   = await fetch(`${base}/api/positions2`, { signal: AbortSignal.timeout(15000) });
    const d   = await r.json();
    const pos = d.positions?.[0];
    if (!pos || d.openingLp == null) return null;
    const totalAeros   = parseFloat(pos.aeroRevenueUSD ?? 0) || 0;
    const totalRevenus = parseFloat(pos.totalPoolUSD ?? 0) + totalAeros
      + parseFloat(d.usdcWallet ?? 0) + parseFloat(d.wethWalletUSD ?? 0) - parseFloat(d.openingLp ?? 0);
    return { totalRevenus, totalAeros };
  } catch (_) { return null; }
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
  // Montant AERO→USDC réel, lu depuis les logs Transfer du receipt (collectFees step2) —
  // fiable, contrairement à un diff de solde wallet avant/après sur des requêtes séparées.
  const feesCollected = parseFloat(out.step2?.aeroUsdcReceived ?? 0) || 0;
  out.aeroSplit = await sendAeroSplit(feesCollected, isLow);

  try   { out.closeLP = await closeLP(base, true, isLow ? 'oor_close_low' : 'oor_close_high', feesCollected, isLow ? 0.25 : 0.5); } // pas de swap forcé, quel que soit le côté
  catch (e) { out.closeLPError = e.message; }

  // Mémorise le côté de sortie pour déterminer le ratio de réouverture (Règle 2, tick suivant)
  try { await kv.set('p2_last_exit_side', isLow ? 'low' : 'high', { ex: 3600 }); } catch (_) {}

  await clearAlgoState();
  return out;
}

/**
 * Collecte les AERO (pendant que la position est encore stakée), ferme la LP,
 * puis rouvre immédiatement avec tout le capital disponible au ratio de tendance.
 */
async function runCollect(base, price, targetRatio = 0.5, closeReason = null) {
  const out = {};

  // Collect AERO avant fermeture — position encore stakée, getReward fonctionne
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
  // Montant AERO→USDC réel, lu depuis les logs Transfer du receipt (collectFees step2)
  const feesCollected = parseFloat(out.step2?.aeroUsdcReceived ?? 0) || 0;
  out.aeroSplit = await sendAeroSplit(feesCollected, true); // Règle 1c : toujours 25%/75%

  // Fermer la LP
  try   { out.closeLP = await closeLP(base, true, closeReason, feesCollected, 0.25); }
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

  // 2. Range dynamique = 1.25 × percentile 24h (min 2%, fallback 10%)
  const pct24h   = await getPercentileRange();
  const p24h     = pct24h && pct24h.cnt >= 10 && pct24h.p05 > 0
    ? (pct24h.p95 - pct24h.p05) / pct24h.p05 * 100
    : null;
  let rangePct = parseFloat((p24h !== null ? p24h * 1.25 : 10).toFixed(2));

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
    // openingLp = capital réellement déployé dans la LP, hors solde resté inutilisé dans le wallet
    // (résidu de swap/arrondi après createPosition + swap-weth-usdc)
    const [usdcDust, wethDust] = await Promise.all([getWalletUsdc(), getWalletWeth()]);
    const dustUsd  = usdcDust + wethDust * price;
    const openingLp = parseFloat(Math.max(0, capital - dustUsd).toFixed(2));
    await kv.set('p2_opening_total', openingTotal, { ex: 30 * 86400 });
    await kv.set('p2_opening_lp',   openingLp, { ex: 30 * 86400 });
    result.openingTotal = openingTotal;
    result.openingLp    = openingLp;

    // Tendance MM14j × MM24h au moment de l'ouverture (ex: "HB", "NN", "NB"…)
    const [openAvg14d, openAvg24h] = await Promise.all([getPriceAverage14d(), getPriceAverage24h()]);
    const openTrend = `${trendLetter(price, openAvg14d)}${trendLetter(price, openAvg24h)}`;
    await kv.set('p2_open_trend', openTrend, { ex: 30 * 86400 });
    result.openTrend = openTrend;

    if (process.env.DATABASE_URL && pool.tokenId) {
      const sql = neon(process.env.DATABASE_URL);
      await sql`UPDATE lp_events SET total_at_open = ${openingTotal}, open_trend = ${openTrend} WHERE token_id = ${pool.tokenId} AND COALESCE(pool_num, 2) = 2`;
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
  const [lpState, rtConfig, oorCountRaw, avg14d, avg24h] = await Promise.all([
    readLpState(ALGO_CONFIG.POOL_NUM),
    kv.get(REDIS_KEYS.RUNTIME_CONFIG),
    kv.get('p2_oor_count').catch(() => null),
    getPriceAverage14d(),
    getPriceAverage24h(),
  ]);

  // Tendance MM14j × MM24h → ratio de réouverture dynamique (utilisé Règles 1c, 1d et 2)
  const trend14d        = trendLetter(price, avg14d);
  const trend24h        = trendLetter(price, avg24h);
  const reopenRatio     = reopenRatioFromTrends(trend14d, trend24h);
  const currentTrendCode = `${trend14d}${trend24h}`;
  result.avg14d      = avg14d;
  result.avg24h      = avg24h;
  result.trend14d    = trend14d;
  result.trend24h    = trend24h;
  result.reopenRatio = reopenRatio;
  result.currentTrendCode = currentTrendCode;

  // Suivi de la stabilité de la tendance courante (depuis quand le code HH/HB/… n'a pas changé) — pour Règle 1d
  const trackedTrend = await kv.get('p2_trend_track').catch(() => null);
  let trendSince = Date.now();
  if (trackedTrend?.code === currentTrendCode && trackedTrend?.since) {
    trendSince = trackedTrend.since;
  } else {
    await kv.set('p2_trend_track', { code: currentTrendCode, since: trendSince }, { ex: 30 * 86400 }).catch(() => {});
  }
  result.trendStableMs = Date.now() - trendSince;
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

  // Règle 1c : volatilité ±1.5pt → resserrer/élargir le range (ratio dynamique MM14j × MM24h)
  // Uniquement si le total des revenus (pool + AERO + solde wallet − capital déployé) couvre
  // au moins la part AERO déjà comptée dedans — évite de resizer (et réaliser une perte) si la
  // position est globalement perdante hors farming AERO.
  const revenueGate    = hasLP ? await getRevenueGate(base) : null;
  const revenueOk      = !!revenueGate && revenueGate.totalRevenus >= revenueGate.totalAeros;
  result.revenueGate   = revenueGate;
  if (hasLP && revenueOk && !isNaN(rMin) && !isNaN(rMax)) {
    const pctData = await getPercentileRange();
    const p24h    = pctData && pctData.cnt >= 10 && pctData.p05 > 0
      ? (pctData.p95 - pctData.p05) / pctData.p05 * 100
      : null;
    if (p24h !== null) {
      const rangePctActuel = (rMax - rMin) / rMin * 100;
      // Même base que la largeur appliquée à l'ouverture (percentile24h × 1.25) — comparaison homogène
      const optimalRange   = p24h * 1.25;
      result.rangePctActuel = parseFloat(rangePctActuel.toFixed(2));
      result.optimalRange   = parseFloat(optimalRange.toFixed(2));
      if (optimalRange < rangePctActuel - 1.5) {
        console.log(`[botLoop 1c] range_shrink — actuel=${rangePctActuel.toFixed(2)}% optimal=${optimalRange.toFixed(2)}% p24h=${p24h.toFixed(2)}%`);
        result.action  = 'range_shrink_rebalance';
        result.collect = await runCollect(base, price, reopenRatio, 'range_shrink_rebalance');
        await logBotTick(kv, result);
        return result;
      } else if (optimalRange > rangePctActuel + 1.5) {
        console.log(`[botLoop 1c] range_expand — actuel=${rangePctActuel.toFixed(2)}% optimal=${optimalRange.toFixed(2)}% p24h=${p24h.toFixed(2)}%`);
        result.action  = 'range_expand_rebalance';
        result.collect = await runCollect(base, price, reopenRatio, 'range_expand_rebalance');
        await logBotTick(kv, result);
        return result;
      }
    }
  }

  // Règle 1d : changement de tendance → resserrer/élargir le range (ratio dynamique MM14j × MM24h)
  // Même garde-fou revenus que la Règle 1c. Se déclenche si le code de tendance actuel (HH/HB/HN…)
  // diffère de celui de l'ouverture ET est stable depuis au moins 6h (évite de réagir à un flap).
  if (hasLP && revenueOk) {
    // Redis en priorité ; fallback DB uniquement si la clé Redis est absente/expirée
    let openTrendCode = await kv.get('p2_open_trend').catch(() => null);
    if (!openTrendCode) {
      try {
        const sqlOt = neon(process.env.DATABASE_URL);
        const rows  = await sqlOt`SELECT open_trend FROM lp_events WHERE action1 = 'CREATE_OK' AND action2 IS NULL AND COALESCE(pool_num, 2) = 2 ORDER BY id DESC LIMIT 1`;
        openTrendCode = rows[0]?.open_trend ?? null;
      } catch (_) {}
    }
    const trendChanged  = !!openTrendCode && currentTrendCode !== openTrendCode;
    const trendStable6h = (Date.now() - trendSince) >= 6 * 60 * 60 * 1000;
    result.openTrendCode = openTrendCode;
    result.trendChanged  = trendChanged;
    if (trendChanged && trendStable6h) {
      console.log(`[botLoop 1d] trend_shift — open=${openTrendCode} current=${currentTrendCode} stableMs=${Date.now() - trendSince}`);
      result.action  = 'trend_shift_rebalance';
      result.collect = await runCollect(base, price, reopenRatio, 'trend_shift_rebalance');
      await logBotTick(kv, result);
      return result;
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

    // Spread check : marché trop agité → attendre (appliqué quel que soit le côté de sortie Règle 1A)
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

    // Ratio de réouverture dynamique selon tendance MM14j × MM24h (calculé plus haut)
    await kv.del('p2_last_exit_side').catch(() => {});

    result.autoStart = await autoStart({ base, price, targetRatio: reopenRatio });
    result.action    = result.autoStart.skipped ? 'auto_start_skipped' : 'auto_started';
    await logBotTick(kv, result);
    return result;
  }

  // En range, position active → rien à faire
  result.action = 'in_range_ok';

  await logBotTick(kv, result);
  return result;
}
