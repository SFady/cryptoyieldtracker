import { ethers } from "ethers";

export const runtime     = "nodejs";
export const maxDuration = 300;

const NFPM        = "0x827922686190790b37229fd06084350E74485b72";
const SWAP_ROUTER = "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5";
const WETH        = "0x4200000000000000000000000000000000000006";
const USDC        = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const POOL        = "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";
const VOTER       = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";

const RPC_URLS = [
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
];

const MAX_UINT128 = (1n << 128n) - 1n;

const ERC20_IFACE = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const NFPM_IFACE = new ethers.Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) returns (uint256 amount0, uint256 amount1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)",
]);

const GAUGE_IFACE = new ethers.Interface([
  "function stakedValues(address depositor) view returns (uint256[])",
  "function withdraw(uint256 tokenId)",
  "function getReward(uint256 tokenId)",
]);

const VOTER_IFACE = new ethers.Interface([
  "function gauges(address pool) view returns (address)",
]);

const SWAP_ROUTER_IFACE = new ethers.Interface([
  "function exactInputSingle((address tokenIn, address tokenOut, int24 tickSpacing, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut)",
]);

async function pickRpc() {
  return new Promise((resolve) => {
    let done = false;
    let pending = RPC_URLS.length;
    for (const url of RPC_URLS) {
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        signal: AbortSignal.timeout(4000),
      })
        .then(r => r.json())
        .then(j => { if (!done && j.result) { done = true; resolve(url); } })
        .catch(() => {})
        .finally(() => { if (--pending === 0 && !done) resolve(RPC_URLS[0]); });
    }
  });
}

async function view(provider, to, iface, fn, args = []) {
  const hex = await provider.call({ to, data: iface.encodeFunctionData(fn, args) });
  return iface.decodeFunctionResult(fn, hex);
}


export async function POST() {
  try {
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) return Response.json({ error: "PRIVATE_KEY manquant" }, { status: 500 });

    const rpcUrl   = await pickRpc();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet   = new ethers.Wallet(privateKey, provider);
    const freshDeadline = () => Math.floor(Date.now() / 1000) + 600;

    // 1. Gauge + tickSpacing
    const [gaugeAddr] = await view(provider, VOTER, VOTER_IFACE, "gauges", [POOL]);
    if (!gaugeAddr || gaugeAddr === ethers.ZeroAddress)
      return Response.json({ error: "Gauge introuvable" }, { status: 500 });

    const tsRaw      = await provider.call({ to: POOL, data: "0xd0c93a7c" });
    const tickSpacing = Number(ethers.toBigInt(tsRaw));

    // 2. Unstake toutes les positions du gauge
    const unstakedList = [];
    try {
      const [stakedIds] = await view(provider, gaugeAddr, GAUGE_IFACE, "stakedValues", [wallet.address]);
      for (const tokenId of stakedIds) {
        // Claim rewards AERO (silencieux)
        try {
          const tx = await wallet.sendTransaction({
            to: gaugeAddr,
            data: GAUGE_IFACE.encodeFunctionData("getReward", [tokenId]),
          });
          await tx.wait();
        } catch (_) {}

        const tx = await wallet.sendTransaction({
          to: gaugeAddr,
          data: GAUGE_IFACE.encodeFunctionData("withdraw", [tokenId]),
        });
        await tx.wait();
        unstakedList.push(tokenId.toString());
      }
    } catch (e) {
      throw new Error(`[unstake] ${e.shortMessage ?? e.message}`);
    }

    // 3. Toutes les positions NFT dans le wallet (y compris celles qui viennent d'être unstakées)
    const collectedList = [];
    try {
      // balanceOf peut être surévalué sur le NFPM Aerodrome (compte aussi les NFTs stakés),
      // donc on boucle avec try/catch et on s'arrête au premier index invalide.
      const [count] = await view(provider, NFPM, NFPM_IFACE, "balanceOf", [wallet.address]);
      const tokenIds = [];
      for (let i = 0n; i < count; i++) {
        try {
          const [tid] = await view(provider, NFPM, NFPM_IFACE, "tokenOfOwnerByIndex", [wallet.address, i]);
          tokenIds.push(tid);
        } catch (_) { break; }
      }

      for (const tokenId of tokenIds) {
        const pos = await view(provider, NFPM, NFPM_IFACE, "positions", [tokenId]);

        // Filtrer : seulement les positions de ce pool WETH/USDC
        if (
          pos.token0.toLowerCase() !== WETH.toLowerCase() ||
          pos.token1.toLowerCase() !== USDC.toLowerCase()
        ) continue;

        // Rien à faire : position vide et sans fees
        if (pos.liquidity === 0n && pos.tokensOwed0 === 0n && pos.tokensOwed1 === 0n) continue;

        // Retirer toute la liquidité si > 0
        if (pos.liquidity > 0n) {
          try {
            const tx = await wallet.sendTransaction({
              to: NFPM,
              data: NFPM_IFACE.encodeFunctionData("decreaseLiquidity", [{
                tokenId,
                liquidity:  pos.liquidity,
                amount0Min: 0n,
                amount1Min: 0n,
                deadline:   freshDeadline(),
              }]),
            });
            await tx.wait();
          } catch (e) {
            throw new Error(`[decreaseLiquidity tokenId=${tokenId}] ${e.shortMessage ?? e.message}`);
          }
        }

        // Collecter fees + tokens retirés
        try {
          const tx = await wallet.sendTransaction({
            to: NFPM,
            data: NFPM_IFACE.encodeFunctionData("collect", [{
              tokenId,
              recipient:   wallet.address,
              amount0Max:  MAX_UINT128,
              amount1Max:  MAX_UINT128,
            }]),
          });
          await tx.wait();
          collectedList.push(tokenId.toString());
        } catch (e) {
          throw new Error(`[collect tokenId=${tokenId}] ${e.shortMessage ?? e.message}`);
        }
      }
    } catch (e) {
      throw new Error(e.message); // propage le message détaillé
    }

    // 4. Swap tout le WETH → USDC
    let swapHash = null;
    const wethBalHex = await provider.call({
      to: WETH, data: ERC20_IFACE.encodeFunctionData("balanceOf", [wallet.address]),
    });
    const [wethBal] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], wethBalHex);

    if (wethBal > 0n) {
      const txApp = await wallet.sendTransaction({
        to: WETH,
        data: ERC20_IFACE.encodeFunctionData("approve", [SWAP_ROUTER, ethers.MaxUint256]),
      });
      await txApp.wait();

      const txSwap = await wallet.sendTransaction({
        to: SWAP_ROUTER,
        data: SWAP_ROUTER_IFACE.encodeFunctionData("exactInputSingle", [{
          tokenIn:           WETH,
          tokenOut:          USDC,
          tickSpacing,
          recipient:         wallet.address,
          deadline:          freshDeadline(),
          amountIn:          wethBal,
          amountOutMinimum:  0n,
          sqrtPriceLimitX96: 0n,
        }]),
      });
      swapHash = txSwap.hash;
      await txSwap.wait();
    }

    // 5. Solde USDC final
    const usdcBalHex = await provider.call({
      to: USDC, data: ERC20_IFACE.encodeFunctionData("balanceOf", [wallet.address]),
    });
    const [usdcBal] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], usdcBalHex);
    const finalUsdc  = Number(ethers.formatUnits(usdcBal, 6)).toLocaleString("en-US", { minimumFractionDigits: 2 });

    return Response.json({
      message:   `Tout fermé. Solde USDC final : $${finalUsdc}`,
      unstaked:  unstakedList,
      collected: collectedList,
      swapHash,
      finalUsdc,
    });

  } catch (e) {
    return Response.json({ error: e.shortMessage ?? e.message }, { status: 500 });
  }
}
