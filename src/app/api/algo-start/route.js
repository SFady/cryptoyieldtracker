import { ethers } from 'ethers';
import { kv }     from '@vercel/kv';
import { REDIS_KEYS } from '../../lib/clm-algo/config.js';

export const runtime     = 'nodejs';
export const maxDuration = 120;

const USDC_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const RPC_URLS = [
  process.env.ALCHEMY_RPC_URL,
  'https://base.drpc.org',
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
  'https://mainnet.base.org',
].filter(Boolean);

async function getWalletUsdc() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) return 0;
  const wallet  = new ethers.Wallet(privateKey.trim());
  const iface   = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
  const data    = iface.encodeFunctionData('balanceOf', [wallet.address]);
  for (const url of RPC_URLS) {
    try {
      const res  = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: USDC_ADDRESS, data }, 'latest'] }),
        signal:  AbortSignal.timeout(6000),
      });
      const json = await res.json();
      if (json.result && json.result !== '0x') {
        const raw = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], json.result)[0];
        return Number(raw) / 1e6;
      }
    } catch (_) {}
  }
  return 0;
}

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
    // 1. Solde USDC du wallet
    const capital = await getWalletUsdc();
    steps.push(`Capital wallet : $${capital.toFixed(2)}`);
    if (capital < 50) {
      return Response.json({ ok: false, skipped: true, reason: `USDC insuffisant : $${capital.toFixed(2)} (min $50)`, steps });
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

    // 4. Range 15% (±7.5%)
    const rangePct = 10;
    const halfFrac = rangePct / 200;
    const minPrice = parseFloat((livePrice / (1 + halfFrac)).toFixed(2));
    const maxPrice = parseFloat((livePrice * (1 + halfFrac)).toFixed(2));
    steps.push(`Prix $${livePrice} · range 10% · bornes $${minPrice}–$${maxPrice}`);

    // 5. Créer la LP 50/50
    const poolRes = await fetch(`${base}/api/createPosition`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        amountUSDC:   capital,
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

    // 6. Prix HL live (juste avant le short)
    let P0_hl = livePrice;
    try {
      const hlPriceRes  = await fetch(`${base}/api/hyperliquid-short`, { signal: AbortSignal.timeout(8000) });
      const hlPriceData = await hlPriceRes.json();
      if (hlPriceData.ethPrice) P0_hl = hlPriceData.ethPrice;
    } catch (_) {}
    steps.push(`Prix HL : $${P0_hl}`);

    // 7. Taille delta-neutre : L = Capital / (2√P0 − P0/√Pb − √Pa)
    //    ETH_open = L × (1/√P0 − 1/√Pb)
    const sqrtP0   = Math.sqrt(livePrice);
    const sqrtPa   = Math.sqrt(Pa);
    const sqrtPb   = Math.sqrt(Pb);
    const L        = capital / (2 * sqrtP0 - livePrice / sqrtPb - sqrtPa);
    const ethAtOpen = parseFloat((L * (1 / sqrtP0 - 1 / sqrtPb)).toFixed(4));
    const leverage  = 4;
    steps.push(`Delta-neutre : ${ethAtOpen} ETH · levier ×${leverage} · SL $${Pb}`);

    // 8. Ouvrir le short avec SL à la borne haute
    const shortRes = await fetch(`${base}/api/hyperliquid-short`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sizeEth: ethAtOpen, leverage, slPriceTrigger: Pb }),
      signal:  AbortSignal.timeout(30000),
    });
    const short = await shortRes.json();
    if (!short.ok) return Response.json({ error: `hyperliquid-short : ${short.error}`, steps }, { status: 500 });
    const avgPx = parseFloat(short.ioStatus?.filled?.avgPx ?? short.ethPrice ?? P0_hl);
    steps.push(`Short @ $${avgPx} ✓`);

    // 9. Initialiser l'état Redis du bot
    await Promise.all([
      kv.set(REDIS_KEYS.RUNTIME_CONFIG, {
        capital, leverage, shortSizeEth: ethAtOpen, rangePct,
        liquidityL: L, tickUpperPrice: Pb,
        startedAt: new Date().toISOString(),
      }, { ex: 30 * 86400 }),
      kv.del(REDIS_KEYS.POSITION_STATE),
      kv.del(REDIS_KEYS.HEDGE_STATE),
      kv.del(REDIS_KEYS.OOR_SINCE),
      kv.del('p2_hedge_bucket'),
    ]);
    steps.push('État Redis initialisé ✓');

    return Response.json({
      ok: true,
      capital: parseFloat(capital.toFixed(2)),
      livePrice,
      minPrice, maxPrice,
      tickLowerPrice: Pa, tickUpperPrice: Pb,
      ethAtOpen, leverage,
      shortEntryPrice: avgPx,
      steps,
    });

  } catch (e) {
    return Response.json({ error: e.message, steps }, { status: 500 });
  }
}
