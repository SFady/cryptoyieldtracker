import { ethers } from 'ethers';
import { kv }     from '@vercel/kv';
import { neon }   from '@neondatabase/serverless';
import { REDIS_KEYS } from '../../lib/clm-algo/config.js';
import { getPercentileRange, readPriceAnchor7d, writePriceAnchor7d } from '../../lib/cronKv.js';

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
 * Flux complet pool 2 : LP 2× range percentile, ratio 50/50.
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

    // 2. Prix live
    const priceRes  = await fetch(`${base}/api/livePrice`, { signal: AbortSignal.timeout(8000) });
    const priceData = await priceRes.json();
    const livePrice = priceData.price;
    if (!livePrice) return Response.json({ error: 'Prix indisponible', steps }, { status: 503 });

    // Capital total = USDC + WETH valorisé au prix live
    const capital = usdcBalance + wethBalance * livePrice;
    steps.push(`Capital total : $${capital.toFixed(2)} (USDC $${usdcBalance.toFixed(2)} + ${wethBalance.toFixed(4)} WETH × $${livePrice.toFixed(0)})`);

    // 4. Range dynamique = 1 × percentile 24h (min 2%, fallback 10%)
    const pct24h   = await getPercentileRange();
    const p24h     = pct24h && pct24h.cnt >= 10 && pct24h.p05 > 0
      ? (pct24h.p95 - pct24h.p05) / pct24h.p05 * 100
      : null;
    const rangePct = parseFloat(Math.max(2, p24h !== null ? p24h : 10).toFixed(2));
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

    // 5b. Convertir le WETH résiduel en USDC
    try {
      const swapRes  = await fetch(`${base}/api/swap-weth-usdc`, { method: 'POST', signal: AbortSignal.timeout(45000) });
      const swapData = await swapRes.json();
      if (swapData.ok && !swapData.skipped) steps.push(`WETH résiduel swappé → ${swapData.wethSwapped?.toFixed(4)} ETH → USDC ✓`);
    } catch (_) {}

    // 6. Initialiser ancre de tendance si absente
    const existingAnchor = await readPriceAnchor7d();
    if (!existingAnchor) {
      await writePriceAnchor7d(livePrice);
      steps.push(`Ancre tendance initialisée à $${livePrice} ✓`);
    } else {
      steps.push(`Ancre tendance existante : $${parseFloat(existingAnchor).toFixed(2)}`);
    }

    // 7. Initialiser l'état Redis du bot (sans short)
    const sqrtPa = Math.sqrt(Pa);
    const sqrtPb = Math.sqrt(Pb);
    const P0_lp  = Math.sqrt(Pa * Pb);
    const L      = capital / (2 * Math.sqrt(P0_lp) - P0_lp / sqrtPb - sqrtPa);

    await Promise.all([
      kv.set(REDIS_KEYS.RUNTIME_CONFIG, {
        capital, rangePct, liquidityL: L,
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

    // 8. Total au démarrage (Redis + Neon)
    try {
      const openingTotal = parseFloat(capital.toFixed(2));
      await kv.set('p2_opening_total', openingTotal, { ex: 30 * 86400 });
      await kv.set('p2_opening_lp',   openingTotal, { ex: 30 * 86400 });
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
      steps,
    });

  } catch (e) {
    return Response.json({ error: e.message, steps }, { status: 500 });
  }
}
