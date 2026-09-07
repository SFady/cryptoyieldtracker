import { ethers } from 'ethers';
import { getPoolAddress } from '../../lib/config';

export const runtime     = 'nodejs';
export const maxDuration = 60;

const V2_ROUTER    = '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43'; // Aerodrome V2 router — même route éprouvée que createPosition.js
const V2_FACTORY   = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
const WETH         = '0x4200000000000000000000000000000000000006';
const USDC         = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const MIN_WETH     = 0.0001; // ~$0.25 — en dessous c'est de la poussière

const RPC_URLS = [
  process.env.ALCHEMY_RPC_URL,
  'https://base.drpc.org',
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
  'https://mainnet.base.org',
].filter(Boolean);

const ERC20_IFACE = new ethers.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
]);

const V2_ROUTER_IFACE = new ethers.Interface([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)',
]);

function freshDeadline() { return BigInt(Math.floor(Date.now() / 1000) + 120); }

export async function POST(req) {
  let poolNum = 2;
  try { const body = await req.json(); if (body?.poolNum) poolNum = body.poolNum; } catch (_) {}

  const privateKey = poolNum === 3 ? process.env.PRIVATE_KEY_3 : process.env.PRIVATE_KEY;
  if (!privateKey) return Response.json({ error: `PRIVATE_KEY${poolNum === 3 ? "_3" : ""} manquant` }, { status: 500 });

  let provider;
  for (const url of RPC_URLS) {
    try {
      provider = new ethers.JsonRpcProvider(url);
      await provider.getBlockNumber();
      break;
    } catch (_) {}
  }
  if (!provider) return Response.json({ error: 'RPC indisponible' }, { status: 503 });

  const wallet = new ethers.Wallet(privateKey.trim(), provider);
  const POOL   = getPoolAddress(poolNum);

  try {
    // Lire le solde WETH
    const wethBalRaw = await provider.call({ to: WETH, data: ERC20_IFACE.encodeFunctionData('balanceOf', [wallet.address]) });
    const wethBal    = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], wethBalRaw)[0];
    const wethFloat  = Number(wethBal) / 1e18;

    if (wethFloat < MIN_WETH) {
      return Response.json({ ok: true, skipped: true, reason: `WETH trop faible (${wethFloat.toFixed(6)} ETH)` });
    }

    // Prix live du pool (slot0) — sert à calculer le minOut, comme dans createPosition.js
    const s0  = await provider.call({ to: POOL, data: '0x3850c7bd' });
    const sqX = ethers.AbiCoder.defaultAbiCoder().decode(['uint160'], s0)[0];
    const sqP = Number(sqX) / Number(2n ** 96n);
    const poolPrice = sqP * sqP * 1e12;
    if (!(poolPrice > 100 && poolPrice < 100000)) {
      return Response.json({ error: `Prix pool invalide (${poolPrice})` }, { status: 500 });
    }

    // Approve V2_ROUTER
    try {
      const txApp = await wallet.sendTransaction({ to: WETH, data: ERC20_IFACE.encodeFunctionData('approve', [V2_ROUTER, ethers.MaxUint256]) });
      await txApp.wait();
    } catch (_) {}

    // Swap WETH → USDC via le routeur V2 — même route éprouvée que createPosition.js (jamais échoué en prod)
    let swapHash = null;
    for (const slipPct of [970n, 950n, 900n]) {
      const minOut = wethBal * BigInt(Math.round(poolPrice * 1e6)) / (10n ** 18n) * slipPct / 1000n;
      try {
        const data = V2_ROUTER_IFACE.encodeFunctionData('swapExactTokensForTokens', [
          wethBal, minOut,
          [{ from: WETH, to: USDC, stable: false, factory: V2_FACTORY }],
          wallet.address, freshDeadline(),
        ]);
        const tx = await wallet.sendTransaction({ to: V2_ROUTER, data, gasLimit: 300000n });
        await tx.wait();
        swapHash = tx.hash;
        break;
      } catch (_) {}
    }

    if (!swapHash) return Response.json({ error: 'Swap WETH→USDC échoué' }, { status: 500 });

    // Lire solde USDC final
    const usdcRaw   = await provider.call({ to: USDC, data: ERC20_IFACE.encodeFunctionData('balanceOf', [wallet.address]) });
    const [usdcBal] = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], usdcRaw);

    return Response.json({
      ok: true,
      wethSwapped: wethFloat,
      usdcBalance: Number(usdcBal) / 1e6,
      txHash: swapHash,
    });

  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
