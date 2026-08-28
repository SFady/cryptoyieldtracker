import { ethers } from 'ethers';
import { kv }     from '@vercel/kv';
import { neon }   from '@neondatabase/serverless';
import { REDIS_KEYS } from '../../lib/clm-algo/config.js';
import { getPercentileRange } from '../../lib/cronKv.js';

export const runtime     = 'nodejs';
export const maxDuration = 120;

const USDC_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
const RPC_URLS = [
  process.env.ALCHEMY_RPC_URL,
  'https://base.drpc.org',
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
  'https://mainnet.base.org',
].filter(Boolean);

async function getTokenBalance(tokenAddress, decimals) {
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
        return Number(raw) / 10 ** decimals;
      }
    } catch (_) {}
  }
  return 0;
}

function getWalletUsdc()  { return getTokenBalance(USDC_ADDRESS, 6); }
function getWalletWeth()  { return getTokenBalance(WETH_ADDRESS, 18); }

/**
 * POST /api/algo-start
 * Flux complet pool 2 : LP 20% range 50/50 + short HL delta-neutre avec SL à la borne haute.
 * Même logique que le bouton ▶ START dans DIVERS, mais capital auto (tout le USDC du wallet).
 */
export async function POST() {
  const base = (process.env.APP_URL ?? '').replace(/\/$/, '');
  if (!base) return Response.json({ error: 'APP_URL non configuré' }, { status: 500 });

  const steps = [];

  try {
    // 1. Solde USDC + WETH du wallet (en parallèle)
    const [usdcBalance, wethBalance] = await Promise.all([getWalletUsdc(), getWalletWeth()]);
    steps.push(`Wallet : $${usdcBalance.toFixed(2)} USDC · ${wethBalance.toFixed(4)} WETH`);
    if (usdcBalance < 50 && wethBalance < 0.02) {
      return Response.json({ ok: false, skipped: true, reason: `Capital insuffisant : $${usdcBalance.toFixed(2)} USDC + ${wethBalance.toFixed(4)} WETH`, steps });
    }

    // 2. Annuler ordres HL résiduels
    try {
      await fetch(`${base}/api/hyperliquid-cancel-all`, { method: 'POST', signal: AbortSignal.timeout(30000) });
      steps.push('Cancel ordres HL ✓');
    } catch (_) {
      steps.push('Cancel ordres HL — ignoré (erreur réseau)');
    }

    // 3. Prix live
    const priceRes  = await fetch(`${base}/api/livePrice`, { signal: AbortSignal.timeout(8000) });
    const priceData = await priceRes.json();
    const livePrice = priceData.price;
    if (!livePrice) return Response.json({ error: 'Prix indisponible', steps }, { status: 503 });

    // Capital total = USDC + WETH valorisé au prix live
    const capital = usdcBalance + wethBalance * livePrice;
    steps.push(`Capital total : $${capital.toFixed(2)} (USDC $${usdcBalance.toFixed(2)} + ${wethBalance.toFixed(4)} WETH × $${livePrice.toFixed(0)})`);

    // 4. Range dynamique = 3 × percentile 24h (min 5%, max 15%, fallback 10%)
    const pct24h   = await getPercentileRange();
    const p24h     = pct24h && pct24h.cnt >= 10 && pct24h.p05 > 0
      ? (pct24h.p95 - pct24h.p05) / pct24h.p05 * 100
      : null;
    const rangePct = parseFloat(Math.max(2, Math.min(15, p24h !== null ? 2 * p24h : 10)).toFixed(2));
    const halfFrac = rangePct / 200;
    const minPrice = parseFloat((livePrice / (1 + halfFrac)).toFixed(2));
    const maxPrice = parseFloat((livePrice * (1 + halfFrac)).toFixed(2));
    steps.push(`Prix $${livePrice} · range ${rangePct}% (percentile 24h ${p24h !== null ? p24h.toFixed(2) : '?'}%) · bornes $${minPrice}–$${maxPrice}`);

    // 5. Créer la LP 50/50
    const poolRes = await fetch(`${base}/api/createPosition`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        amountUSDC:   usdcBalance,
        minPrice,
        maxPrice,
        currentPrice: livePrice,
        rangePercent: rangePct,
        targetRatio:  0.5,
        poolNum:      2,
        exactBounds:  true,
      }),
      signal: AbortSignal.timeout(180000),
    });
    const pool = await poolRes.json();
    if (pool.error) return Response.json({ error: `createPosition : ${pool.error}`, steps }, { status: 500 });
    const Pa = pool.tickLowerPrice;
    const Pb = pool.tickUpperPrice;
    steps.push(`LP ouverte ✓ · tick bornes $${Pa}–$${Pb}`);

    // 6. Prix HL live + solde HL (en parallèle, avant le short)
    let P0_hl = livePrice;
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
    steps.push(`Prix HL : $${P0_hl} · solde HL : $${hlAccountValue.toFixed(2)}`);

    // 7. Short 100% pool, limité par marge HL disponible
    const sqrtPa   = Math.sqrt(Pa);
    const sqrtPb   = Math.sqrt(Pb);
    const P0_lp    = Math.sqrt(Pa * Pb);
    const L        = capital / (2 * Math.sqrt(P0_lp) - P0_lp / sqrtPb - sqrtPa);
    const leverage  = 4;
    const targetSizeEth  = capital / P0_hl;
    const maxFromMargin  = hlAccountValue > 0 ? hlAccountValue * leverage / P0_hl : targetSizeEth;
    const ethAtOpen      = parseFloat(Math.min(targetSizeEth, maxFromMargin).toFixed(4));
    const shortWarning   = ethAtOpen < targetSizeEth - 0.0001
      ? `marge HL insuffisante : ${ethAtOpen} ETH sur ${parseFloat(targetSizeEth.toFixed(4))} visés — ajouter $${parseFloat(((targetSizeEth - ethAtOpen) * P0_hl / leverage).toFixed(2))} dans HL`
      : null;
    steps.push(`Short 100% pool : ${ethAtOpen} ETH · levier ×${leverage} · SL $${Pb}${shortWarning ? ` · ⚠ ${shortWarning}` : ''}`);

    // 8. Ouvrir le short avec SL trigger à centre+0.5% (pas à Pb)
    const centrePrice = parseFloat(P0_lp.toFixed(2));
    const slAtDelta   = parseFloat((centrePrice * 1.005).toFixed(2));
    const shortRes = await fetch(`${base}/api/hyperliquid-short`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sizeEth: ethAtOpen, leverage, slPriceTrigger: slAtDelta }),
      signal:  AbortSignal.timeout(30000),
    });
    const short = await shortRes.json();
    if (!short.ok) return Response.json({ error: `hyperliquid-short : ${short.error}`, steps }, { status: 500 });
    const avgPx = parseFloat(short.ioStatus?.filled?.avgPx ?? short.ethPrice ?? P0_hl);
    steps.push(`Short @ $${avgPx} ✓ · SL trigger $${slAtDelta} (centre+0.5%)`);

    // 9. Initialiser l'état Redis du bot
    await Promise.all([
      kv.set(REDIS_KEYS.RUNTIME_CONFIG, {
        capital, leverage, shortSizeEth: ethAtOpen, rangePct,
        liquidityL: L, tickUpperPrice: Pb,
        centrePrice, closeDelta: 0.005,
        startedAt: new Date().toISOString(),
      }, { ex: 30 * 86400 }),
      kv.del(REDIS_KEYS.POSITION_STATE),
      kv.del(REDIS_KEYS.HEDGE_STATE),
      kv.del(REDIS_KEYS.OOR_SINCE),
      kv.del('p2_edge_streak'),
      kv.del('p2_hedge_bucket'),
      kv.set('p2_hedge_fees', 0, { ex: 30 * 86400 }),
    ]);
    steps.push('État Redis initialisé ✓');

    // 10. Total au démarrage (Redis + Neon)
    try {
      const openingTotal = parseFloat((capital + hlAccountValue).toFixed(2));
      await kv.set('p2_opening_total', openingTotal, { ex: 30 * 86400 });
      await kv.set('p2_opening_lp', parseFloat(capital.toFixed(2)), { ex: 30 * 86400 });
      if (process.env.DATABASE_URL && pool.tokenId) {
        const sql = neon(process.env.DATABASE_URL);
        await sql`UPDATE lp_events SET total_at_open = ${openingTotal} WHERE token_id = ${pool.tokenId} AND COALESCE(pool_num, 2) = 2`;
      }
    } catch (_) {}

    return Response.json({
      ok: true,
      capital: parseFloat(capital.toFixed(2)),
      livePrice,
      minPrice, maxPrice,
      tickLowerPrice: Pa, tickUpperPrice: Pb,
      ethAtOpen, targetEthShort: parseFloat(targetSizeEth.toFixed(4)), leverage,
      shortEntryPrice: avgPx,
      ...(shortWarning && { shortWarning }),
      steps,
    });

  } catch (e) {
    return Response.json({ error: e.message, steps }, { status: 500 });
  }
}
