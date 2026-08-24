import { ethers }           from 'ethers';
import { kv }               from '@vercel/kv';
import { ALGO_CONFIG, REDIS_KEYS } from '../config.js';
import { readLpState, readP2Range, writeP2Range } from '../../cronKv.js';
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
    kv.del('p2_hedge_bucket'),
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

  // Fermer le short HL
  try   { out.closeShort = await closeShort(base); }
  catch (e) { out.closeShortError = e.message; }

  // Fermer la LP (retire les fonds, met à jour la DB)
  try   { out.closeLP = await closeLP(base); }
  catch (e) { out.closeLPError = e.message; }

  // Réinitialiser l'état algo (supprime aussi p2_live_range)
  await clearAlgoState();

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

  // 2. Range fixe 15% (±7.5% autour du prix courant)
  const rangePct = 10;
  const halfFrac = rangePct / 200;
  const minPrice = parseFloat((price / (1 + halfFrac)).toFixed(2));
  const maxPrice = parseFloat((price * (1 + halfFrac)).toFixed(2));
  result.rangePct = parseFloat(rangePct.toFixed(2));

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

  // 4. Prix HL live au moment du short (placement uniquement)
  let P0_hl = price;
  try {
    const hlPriceRes  = await fetch(`${base}/api/hyperliquid-short`, { signal: AbortSignal.timeout(8000) });
    const hlPriceData = await hlPriceRes.json();
    if (hlPriceData.ethPrice) P0_hl = hlPriceData.ethPrice;
  } catch (_) {}
  result.hlPrice = P0_hl;

  // 5. Hedge delta-neutre = ETH dans la LP à l'ouverture
  //    L calculé au prix LP (price), pas au prix HL — correspond à la composition réelle de la LP
  //    ETH_open = L × (1/√P0_lp − 1/√Pb)
  const Pa       = pool.tickLowerPrice;
  const Pb       = pool.tickUpperPrice;
  const P0_lp    = price; // prix au moment de la création de la LP
  const sqrtP0   = Math.sqrt(P0_lp);
  const sqrtPa   = Math.sqrt(Pa);
  const sqrtPb   = Math.sqrt(Pb);
  const L        = capital / (2 * sqrtP0 - P0_lp / sqrtPb - sqrtPa);
  const ethAtOpen = parseFloat((L * (1 / sqrtP0 - 1 / sqrtPb)).toFixed(4));
  const leverage = 4;
  result.ethAtOpen = ethAtOpen;

  // 6. Ouvrir le short avec SL à la borne haute
  const shortRes = await fetch(`${base}/api/hyperliquid-short`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ sizeEth: ethAtOpen, leverage, slPriceTrigger: Pb }),
    signal:  AbortSignal.timeout(30000),
  });
  const short = await shortRes.json();
  if (!short.ok) return { ...result, error: `hyperliquid-short : ${short.error}` };
  result.shortEntry = short.ethPrice;

  // 7. Sauvegarder la config runtime (L et Pb pour le hedge dynamique sans appel NFPM)
  await kv.set(REDIS_KEYS.RUNTIME_CONFIG, {
    capital, leverage, shortSizeEth: ethAtOpen, rangePct,
    liquidityL: L, tickUpperPrice: Pb,
    startedAt: new Date().toISOString(),
  }, { ex: 30 * 86400 });
  await kv.del(REDIS_KEYS.POSITION_STATE);
  await kv.del(REDIS_KEYS.HEDGE_STATE);
  await kv.del(REDIS_KEYS.OOR_SINCE);
  await kv.set('p2_hedge_fees', 0, { ex: 30 * 86400 });

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

  // 1. État LP
  const lpState = await readLpState(ALGO_CONFIG.POOL_NUM);
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

  // 2. État short HL
  const { hasShort, sizeEth: currentShortEth } = await getShortState(base);

  result.hasLP    = hasLP;
  result.hasShort = hasShort;
  result.isOOR    = isOOR;
  result.rMin     = rMin ?? null;
  result.rMax     = rMax ?? null;
  result.poolNum  = ALGO_CONFIG.POOL_NUM;

  // Règle 1 : hors range → collect AERO + fermer + rouvrir immédiatement
  if (isOOR) {
    result.action  = 'oor_close_all';
    result.collect = await runCollect(base, price);
    await logBotTick(kv, result);
    return result;
  }

  // Règle 1b : zone bord (5% bas ou 5% haut du range) 3 CRONs consécutifs → rebalance préventif
  const EDGE_KEY = 'p2_edge_streak';
  if (hasLP && !isNaN(rMin) && !isNaN(rMax)) {
    const rangeSize = rMax - rMin;
    const edgeLow   = rMin + 0.05 * rangeSize;
    const edgeHigh  = rMax - 0.05 * rangeSize;
    const inEdge    = price <= edgeLow ? 'lower' : price >= edgeHigh ? 'upper' : null;
    if (inEdge) {
      const prev  = (await kv.get(EDGE_KEY)) ?? { zone: null, count: 0 };
      const count = prev.zone === inEdge ? prev.count + 1 : 1;
      await kv.set(EDGE_KEY, { zone: inEdge, count }, { ex: 7200 });
      result.edgeZone  = inEdge;
      result.edgeCount = count;
      console.log(`[botLoop edge] inEdge=${inEdge} count=${count}`);
      if (count >= 3) {
        result.action  = 'edge_close_all';
        result.collect = await runCollect(base, price);
        await logBotTick(kv, result);
        return result;
      }
    } else {
      await kv.del(EDGE_KEY);
    }
  }

  // Règle 2 : LP sans short → fermer LP (SL déclenché, on ne relance pas)
  if (hasLP && !hasShort) {
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

  // Règle 4 : en range + short actif → hedge dynamique par buckets
  const BUCKET_KEY  = 'p2_hedge_bucket';
  const bucketSize  = (rMax - rMin) / 10;
  const currentBucket = Math.max(0, Math.min(9, Math.floor((price - rMin) / bucketSize)));
  const lastBucket    = await kv.get(BUCKET_KEY);

  result.bucket     = currentBucket;
  result.lastBucket = lastBucket;

  if (lastBucket === null || lastBucket !== currentBucket) {
    try {
      // Calcul WETH dans la LP via formule (L stocké au Start, pas d'appel NFPM)
      const rtConfig  = await kv.get(REDIS_KEYS.RUNTIME_CONFIG);
      const L         = rtConfig?.liquidityL ?? null;
      const Pb_stored = rtConfig?.tickUpperPrice ?? rMax;

      if (!L) {
        // L non disponible (position ouverte avant le fix) → skip sans fermer le short
        result.action = 'hedge_skip_no_L';
        await kv.set(BUCKET_KEY, currentBucket, { ex: 30 * 86400 });
        await logBotTick(kv, result);
        return result;
      }

      let wethInPool = 0;
      if (price < Pb_stored) {
        wethInPool = L * (1 / Math.sqrt(price) - 1 / Math.sqrt(Pb_stored));
        wethInPool = Math.max(0, parseFloat(wethInPool.toFixed(6)));
      }
      result.wethInPool = wethInPool;

      if (wethInPool >= 0.001) {
        const deltaUsd = Math.abs(wethInPool - (currentShortEth ?? 0)) * price;
        if (deltaUsd < 30) {
          result.action   = 'hedge_skip_small_delta';
          result.deltaUsd = parseFloat(deltaUsd.toFixed(2));
          await kv.set(BUCKET_KEY, currentBucket, { ex: 30 * 86400 });
          await logBotTick(kv, result);
          return result;
        }
        const adjustRes = await fetch(`${base}/api/hyperliquid-adjust-short`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ targetEth: wethInPool, slPriceTrigger: rMax, leverage: 4 }),
          signal:  AbortSignal.timeout(45000),
        });
        result.hedgeAdjust = { wethInPool, ...(await adjustRes.json()) };
        result.action = 'hedge_adjusted';
        const _filled = result.hedgeAdjust?.deltaResult?.response?.data?.statuses?.[0]?.filled;
        if (_filled) {
          const _fee = parseFloat(_filled.totalSz) * parseFloat(_filled.avgPx) * 0.00035;
          try { await kv.incrbyfloat('p2_hedge_fees', _fee); } catch (_) {}
        }
      } else {
        // WETH ≈ 0 → prix proche de la borne haute, fermer le short
        await fetch(`${base}/api/hyperliquid-cancel-all`, { method: 'POST', signal: AbortSignal.timeout(30000) });
        result.action = 'hedge_short_closed_weth_null';
      }
      await kv.set(BUCKET_KEY, currentBucket, { ex: 30 * 86400 });
    } catch (e) {
      result.action     = 'hedge_error';
      result.hedgeError = e.message;
    }
  } else {
    result.action = 'in_range_ok';
  }

  await logBotTick(kv, result);
  return result;
}
