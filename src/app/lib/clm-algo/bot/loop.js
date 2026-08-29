import { ethers }           from 'ethers';
import { kv }               from '@vercel/kv';
import { neon }             from '@neondatabase/serverless';
import { ALGO_CONFIG, REDIS_KEYS } from '../config.js';
import { readLpState, readP2Range, writeP2Range, getPercentileRange } from '../../cronKv.js';
import { NFPM_ADDRESS } from '../../config.js';
import { closeShort, getShortState } from '../hedge/hyperliquid.js';
import { logBotTick }       from './metrics.js';

// Module 7 — Orchestrateur cron pool 2
// Règles :
//   1. Hors range          → fermer LP + HL short
//   2. LP sans short       → fermer LP
//   3. Aucune position     → auto-start (LP + short comme le bouton Start)
//   4. En range + short    → rien (short géré par SL HL)

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
 * Collecte les AERO (pendant que la position est encore stakée), ferme short + LP,
 * puis rouvre immédiatement avec tout le capital disponible.
 */
async function runCollect(base, price) {
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

  // Fermer le short HL — bloquant : on vérifie qu'il est réellement fermé avant de rouvrir
  let shortClosed = false;
  try {
    out.closeShort = await closeShort(base);
    const { hasShort } = await getShortState(base);
    shortClosed = !hasShort;
  } catch (e) { out.closeShortError = e.message; }

  // Fermer la LP (même si le short n'a pas pu être fermé)
  try   { out.closeLP = await closeLP(base); }
  catch (e) { out.closeLPError = e.message; }

  // Réinitialiser l'état algo (supprime aussi p2_live_range)
  await clearAlgoState();

  // Si le short n'est pas confirmé fermé → ne pas rouvrir (évite deux shorts en parallèle)
  // Le prochain cron détectera !hasLP && hasShort → Rule 2b fermera le short
  if (!shortClosed) {
    out.autoStartSkipped = 'short_not_closed';
    return out;
  }

  // Rouvrir LP + short avec tout l'USDC disponible (fees AERO + fonds retirés)
  out.autoStart = await autoStart({ base, price });

  // Sauvegarder le nouveau range
  if (out.autoStart?.pool?.tickLowerPrice && out.autoStart?.pool?.tickUpperPrice) {
    await writeP2Range(out.autoStart.pool.tickLowerPrice, out.autoStart.pool.tickUpperPrice);
  }

  return out;
}

/**
 * Recrée une position complète (LP + short) avec toute la liquidité disponible.
 * Même logique que le bouton Start de l'UI.
 */
async function autoStart({ base, price }) {
  const result = { action: 'auto_start' };

  // 1. Capital disponible = USDC + WETH déjà dans le wallet
  // createPosition lit les deux balances et fait 1 seul swap d'équilibrage
  const [usdcBal, wethBal] = await Promise.all([getWalletUsdc(), getWalletWeth()]);
  const capital = usdcBal + wethBal * price;
  if (capital < 10) return { ...result, skipped: true, reason: `Capital insuffisant : $${capital.toFixed(2)}` };
  result.capital = parseFloat(capital.toFixed(2));

  // 2. Range dynamique = 3 × percentile 24h (min 5%, max 15%, fallback 10%)
  const pct24h   = await getPercentileRange();
  const p24h     = pct24h && pct24h.cnt >= 10 && pct24h.p05 > 0
    ? (pct24h.p95 - pct24h.p05) / pct24h.p05 * 100
    : null;
  const rangePct = parseFloat(Math.max(2, p24h !== null ? 1.5 * p24h : 10).toFixed(2));
  const halfFrac = rangePct / 200;
  const minPrice = parseFloat((price / (1 + halfFrac)).toFixed(2));
  const maxPrice = parseFloat((price * (1 + halfFrac)).toFixed(2));
  result.rangePct   = rangePct;
  result.percentile = p24h !== null ? parseFloat(p24h.toFixed(2)) : null;

  // 3. Créer la LP 50/50
  const poolRes = await fetch(`${base}/api/createPosition`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      amountUSDC:   capital,
      minPrice,
      maxPrice,
      currentPrice: price,
      rangePercent: rangePct,
      targetRatio:  0.5,
      poolNum:      ALGO_CONFIG.POOL_NUM,
      exactBounds:  true,
    }),
    signal: AbortSignal.timeout(180000),
  });
  const pool = await poolRes.json();
  if (pool.error) return { ...result, error: `createPosition : ${pool.error}` };
  result.pool = { tickLowerPrice: pool.tickLowerPrice, tickUpperPrice: pool.tickUpperPrice };

  // Convertir le WETH résiduel (non utilisé par la LP) en USDC
  try {
    const swapRes = await fetch(`${base}/api/swap-weth-usdc`, { method: 'POST', signal: AbortSignal.timeout(45000) });
    const swapData = await swapRes.json();
    if (swapData.ok && !swapData.skipped) result.wethSwapped = swapData.wethSwapped;
  } catch (_) {}

  // 4. Prix HL live + solde HL (en parallèle, avant le short)
  let P0_hl = price;
  let hlAccountValue = 0;
  try {
    const [hlPriceRes, hlStatusRes] = await Promise.all([
      fetch(`${base}/api/hyperliquid-short`, { signal: AbortSignal.timeout(8000) }),
      fetch(`${base}/api/hyperliquid-status`, { signal: AbortSignal.timeout(8000) }),
    ]);
    const hlPriceData  = await hlPriceRes.json();
    const hlStatusData = await hlStatusRes.json();
    if (hlPriceData.ethPrice) P0_hl = hlPriceData.ethPrice;
    hlAccountValue = hlStatusData.accountValue ?? 0;
  } catch (_) {}
  result.hlPrice = P0_hl;

  // 5. Short 100% pool, limité par marge HL disponible
  const Pa       = pool.tickLowerPrice;
  const Pb       = pool.tickUpperPrice;
  const sqrtPa   = Math.sqrt(Pa);
  const sqrtPb   = Math.sqrt(Pb);
  const P0_lp    = Math.sqrt(Pa * Pb);
  const L        = capital / (2 * Math.sqrt(P0_lp) - P0_lp / sqrtPb - sqrtPa);
  const leverage  = 4;
  const S_star    = capital / (2 * P0_hl);
  const maxFromMargin = hlAccountValue > 0 ? hlAccountValue * leverage / P0_hl : S_star;
  const ethAtOpen = parseFloat(Math.min(S_star, maxFromMargin).toFixed(4));
  if (ethAtOpen < S_star - 0.0001) {
    const missingUsd = parseFloat(((S_star - ethAtOpen) * P0_hl / leverage).toFixed(2));
    result.shortWarning = `marge HL insuffisante : ${ethAtOpen} ETH sur ${parseFloat(S_star.toFixed(4))} visés — ajouter $${missingUsd} dans HL`;
  }
  result.ethAtOpen      = ethAtOpen;
  result.targetEthShort = parseFloat(S_star.toFixed(4));

  // 6. Ouvrir le short fixe S* (sans SL trigger) — cancel-all d'abord
  try { await fetch(`${base}/api/hyperliquid-cancel-all`, { method: 'POST', signal: AbortSignal.timeout(15000) }); } catch (_) {}
  const shortRes = await fetch(`${base}/api/hyperliquid-short`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ sizeEth: ethAtOpen, leverage }),
    signal:  AbortSignal.timeout(30000),
  });
  const short = await shortRes.json();
  if (!short.ok) return { ...result, error: `hyperliquid-short : ${short.error}` };
  result.shortEntry = short.ethPrice;

  // SL de sécurité à Pb + 5% (protection si cron tombe en panne)
  try {
    await fetch(`${base}/api/hyperliquid-tpsl`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ slPrice: Pb * 1.05, size: ethAtOpen }),
      signal:  AbortSignal.timeout(15000),
    });
  } catch (_) {}

  // 7. Sauvegarder la config runtime
  await kv.set(REDIS_KEYS.RUNTIME_CONFIG, {
    capital, leverage, shortSizeEth: ethAtOpen, rangePct,
    liquidityL: L, tickUpperPrice: Pb,
    startedAt: new Date().toISOString(),
  }, { ex: 30 * 86400 });
  await kv.del(REDIS_KEYS.POSITION_STATE);
  await kv.del(REDIS_KEYS.HEDGE_STATE);
  await kv.del(REDIS_KEYS.OOR_SINCE);
  await kv.set('p2_hedge_fees', 0, { ex: 30 * 86400 });

  // Stocker le total portfolio au démarrage (Redis + Neon fallback)
  try {
    const openingTotal = parseFloat((capital + hlAccountValue).toFixed(2));
    await kv.set('p2_opening_total', openingTotal, { ex: 30 * 86400 });
    await kv.set('p2_opening_lp', parseFloat(capital.toFixed(2)), { ex: 30 * 86400 });
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

  // 1. État LP + config runtime (en parallèle)
  const [lpState, rtConfig] = await Promise.all([
    readLpState(ALGO_CONFIG.POOL_NUM),
    kv.get(REDIS_KEYS.RUNTIME_CONFIG),
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

  // 2. État short HL
  const { hasShort, sizeEth: currentShortEth } = await getShortState(base);

  result.hasLP       = hasLP;
  result.hasShort    = hasShort;
  result.isOOR       = isOOR;
  result.rMin        = rMin ?? null;
  result.rMax        = rMax ?? null;
  result.centerPrice = centerPrice ? parseFloat(centerPrice.toFixed(2)) : null;
  result.poolNum     = ALGO_CONFIG.POOL_NUM;

  // Règle 1 : hors range → collect AERO + fermer + rouvrir immédiatement
  if (isOOR) {
    result.action  = 'oor_close_all';
    result.collect = await runCollect(base, price);
    await logBotTick(kv, result);
    return result;
  }

  // Règle 1c : volatilité réduite → range trop large vs optimal, resserrer (seulement au-dessus du centre)
  if (hasLP && centerPrice && !isNaN(rMin) && !isNaN(rMax)) {
    const pctData = await getPercentileRange();
    const p24h    = pctData && pctData.cnt >= 10 && pctData.p05 > 0
      ? (pctData.p95 - pctData.p05) / pctData.p05 * 100
      : null;
    if (p24h !== null) {
      const rangePctActuel = rtConfig?.rangePct ?? ((rMax - rMin) / rMin * 100);
      const optimalRange   = 1.5 * p24h;
      result.rangePctActuel = parseFloat(rangePctActuel.toFixed(2));
      result.optimalRange   = parseFloat(optimalRange.toFixed(2));
      const p24hAtOpen = rangePctActuel / 1.5;
      if (p24h < p24hAtOpen - 1.5) {
        console.log(`[botLoop 1c] range_shrink — actuel=${rangePctActuel.toFixed(2)}% optimal=${optimalRange.toFixed(2)}% p24h=${p24h.toFixed(2)}% p24hAtOpen=${p24hAtOpen.toFixed(2)}%`);
        result.action  = 'range_shrink_rebalance';
        result.collect = await runCollect(base, price);
        await logBotTick(kv, result);
        return result;
      } else if (p24h > p24hAtOpen + 1.5) {
        console.log(`[botLoop 1c] range_expand — actuel=${rangePctActuel.toFixed(2)}% optimal=${optimalRange.toFixed(2)}% p24h=${p24h.toFixed(2)}% p24hAtOpen=${p24hAtOpen.toFixed(2)}%`);
        result.action  = 'range_expand_rebalance';
        result.collect = await runCollect(base, price);
        await logBotTick(kv, result);
        return result;
      }
    }
  }

  // Règle 2b : short sans LP → fermer le short (LP fermée manuellement ou erreur)
  if (!hasLP && hasShort) {
    result.action = 'no_lp_close_short';
    try   { result.closeShort = await closeShort(base); }
    catch (e) { result.closeShortError = e.message; }
    await clearAlgoState();
    await logBotTick(kv, result);
    return result;
  }

  // Règle 2 : LP sans short sans centerPrice → état incohérent, fermer LP
  // Si centerPrice connu, Rule 4 gère la réouverture du short (évite fermeture LP intempestive)
  if (hasLP && !hasShort && !centerPrice) {
    result.action = 'no_short_close_lp';
    try   { result.closeLP = await closeLP(base); }
    catch (e) { result.closeLPError = e.message; }
    await clearAlgoState();
    await logBotTick(kv, result);
    return result;
  }

  // Règle 3 : aucune position → auto-start
  if (!hasLP && !hasShort) {
    result.autoStart = await autoStart({ base, price });
    result.action    = result.autoStart.skipped ? 'auto_start_skipped' : 'auto_started';
    await logBotTick(kv, result);
    return result;
  }

  // Règle 4 : short fixe S* — si absent, rouvrir au marché sans trigger
  if (!hasShort) {
    result.action = 'reopen_short_fixed';
    const sizeEth  = rtConfig?.shortSizeEth ?? 0;
    const leverage = rtConfig?.leverage ?? 4;
    if (sizeEth > 0) {
      try { await fetch(`${base}/api/hyperliquid-cancel-all`, { method: 'POST', signal: AbortSignal.timeout(15000) }); } catch (_) {}
      try {
        const r = await fetch(`${base}/api/hyperliquid-short`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ sizeEth, leverage }),
          signal:  AbortSignal.timeout(30000),
        });
        result.reopenShort = await r.json();
      } catch (e) { result.reopenShortError = e.message; }
      const Pb = rtConfig?.tickUpperPrice;
      if (Pb && result.reopenShort?.ok) {
        try {
          await fetch(`${base}/api/hyperliquid-tpsl`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ slPrice: Pb * 1.05, size: sizeEth }),
            signal:  AbortSignal.timeout(15000),
          });
        } catch (_) {}
      }
    }
  } else {
    result.action = 'in_range_ok';
  }

  await logBotTick(kv, result);
  return result;
}
