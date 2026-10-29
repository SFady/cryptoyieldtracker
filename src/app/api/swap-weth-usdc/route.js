import { ethers } from 'ethers';
import { getPoolAddress } from '../../lib/config';
import { isAuthorized, unauthorizedResponse } from '../../lib/apiAuth';

export const runtime     = 'nodejs';
export const maxDuration = 60;

const WETH         = '0x4200000000000000000000000000000000000006';
const USDC         = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const MIN_WETH     = 0.0001; // ~$0.25 — en dessous c'est de la poussière
// Migration Aero (24/10) : swap via le Metarouter sur notre pool CL, remplace l'ancien V2_ROUTER.
const METAROUTER   = '0x0fEf9e88A7b76BCDBF451780C6774FE32965Ee98';
const CMD_CL_SWAP_EXACT_IN = 0x00;
const METAROUTER_IFACE = new ethers.Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const SWAP_EXACT_IN_PARAMS_TYPE = 'tuple(address[] pools, address tokenIn, tuple(uint8 mode, uint256 value) amountIn, bool payerIsUser, uint256 minAmountOut, address recipient)';

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

// Deadline ≥ ~50min requis par le Metarouter (confirmé par dichotomie le 25/10), pas 120s.
function freshDeadline() { return BigInt(Math.floor(Date.now() / 1000) + 3600); }

export async function POST(req) {
  if (!isAuthorized(req)) return unauthorizedResponse();
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

    // Approve Metarouter
    try {
      const txApp = await wallet.sendTransaction({ to: WETH, data: ERC20_IFACE.encodeFunctionData('approve', [METAROUTER, ethers.MaxUint256]) });
      await txApp.wait();
    } catch (_) {}

    // Swap WETH → USDC via le Metarouter (pool CL WETH/USDC du nouveau protocole Aero)
    let swapHash = null;
    for (const slipPct of [970n, 950n, 900n]) {
      const minOut = wethBal * BigInt(Math.round(poolPrice * 1e6)) / (10n ** 18n) * slipPct / 1000n;
      try {
        const params = {
          pools: [POOL], tokenIn: WETH,
          amountIn: { mode: 0, value: wethBal },
          payerIsUser: true,
          minAmountOut: minOut,
          recipient: wallet.address,
        };
        const input0 = ethers.AbiCoder.defaultAbiCoder().encode([SWAP_EXACT_IN_PARAMS_TYPE], [params]);
        const data = METAROUTER_IFACE.encodeFunctionData('execute', [
          ethers.hexlify(new Uint8Array([CMD_CL_SWAP_EXACT_IN])), [input0], freshDeadline(),
        ]);
        // Gas limit = estimation ×2 (29/10) : le 300000 fixe est sous le besoin réel d'un swap sur
        // le pool CL (~510k) → revert "IG" systématique. Voir metarouterSwapExactIn dans loop.js.
        // L'estimation sert aussi de simulation gratuite avant l'envoi.
        const est = await provider.estimateGas({ to: METAROUTER, from: wallet.address, data });
        const tx = await wallet.sendTransaction({ to: METAROUTER, data, gasLimit: est * 2n });
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
