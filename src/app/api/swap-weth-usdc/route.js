import { ethers } from 'ethers';

export const runtime     = 'nodejs';
export const maxDuration = 60;

const SWAP_ROUTER  = '0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5';
const WETH         = '0x4200000000000000000000000000000000000006';
const USDC         = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TICK_SPACINGS = [100, 200, 1, 50]; // essayés dans l'ordre jusqu'au premier succès
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

const SWAP_IFACE = new ethers.Interface([
  'function exactInputSingle((address tokenIn, address tokenOut, int24 tickSpacing, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut)',
]);

function freshDeadline() { return BigInt(Math.floor(Date.now() / 1000) + 120); }

export async function POST() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) return Response.json({ error: 'PRIVATE_KEY manquant' }, { status: 500 });

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

  try {
    // Lire le solde WETH
    const wethBalRaw = await provider.call({ to: WETH, data: ERC20_IFACE.encodeFunctionData('balanceOf', [wallet.address]) });
    const wethBal    = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], wethBalRaw)[0];
    const wethFloat  = Number(wethBal) / 1e18;

    if (wethFloat < MIN_WETH) {
      return Response.json({ ok: true, skipped: true, reason: `WETH trop faible (${wethFloat.toFixed(6)} ETH)` });
    }

    // Approve SWAP_ROUTER
    try {
      const txApp = await wallet.sendTransaction({ to: WETH, data: ERC20_IFACE.encodeFunctionData('approve', [SWAP_ROUTER, ethers.MaxUint256]) });
      await txApp.wait();
    } catch (_) {}

    // Swap WETH → USDC : essai de chaque tick spacing puis slippage croissant
    let swapHash = null;
    outer: for (const tickSpacing of TICK_SPACINGS) {
      for (const pct of [995n, 990n, 980n]) {
        try {
          const priceData = SWAP_IFACE.encodeFunctionData('exactInputSingle', [{
            tokenIn: WETH, tokenOut: USDC, tickSpacing,
            recipient: wallet.address, deadline: freshDeadline(),
            amountIn: wethBal, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
          }]);
          const simResult = await provider.call({ to: SWAP_ROUTER, data: priceData });
          const [simOut]  = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], simResult);
          const minOut    = simOut * pct / 1000n;

          const data = SWAP_IFACE.encodeFunctionData('exactInputSingle', [{
            tokenIn: WETH, tokenOut: USDC, tickSpacing,
            recipient: wallet.address, deadline: freshDeadline(),
            amountIn: wethBal, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
          }]);
          const tx = await wallet.sendTransaction({ to: SWAP_ROUTER, data, gasLimit: 300000n });
          await tx.wait();
          swapHash = tx.hash;
          break outer;
        } catch (_) {}
      }
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
