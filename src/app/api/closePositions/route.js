import { ethers } from "ethers";

export const runtime     = "nodejs";
export const maxDuration = 300;

const NFPM        = "0x827922686190790b37229fd06084350E74485b72";
const SWAP_ROUTER = "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5";
const WETH        = "0x4200000000000000000000000000000000000006";
const AERO        = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
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

const POOL_IFACE = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

async function waitForTx(provider, tx) {
  try {
    const r = await tx.wait();
    if (r?.status === 0) throw new Error("reverted");
    return r;
  } catch (_) {
    for (let i = 0; i < 30; i++) {
      await new Promise(res => setTimeout(res, 2000));
      const r = await provider.getTransactionReceipt(tx.hash);
      if (r) {
        if (r.status === 0) throw new Error(`revert on-chain (hash=${tx.hash})`);
        return r;
      }
    }
    throw new Error(`timeout confirmation tx ${tx.hash}`);
  }
}

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

    // Détecter automatiquement le stablecoin du pool (token0 ou token1 selon lequel n'est pas WETH)
    const [poolToken0] = await view(provider, POOL, POOL_IFACE, "token0");
    const [poolToken1] = await view(provider, POOL, POOL_IFACE, "token1");
    const stablecoin = poolToken0.toLowerCase() === WETH.toLowerCase() ? poolToken1 : poolToken0;

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
          await waitForTx(provider, tx);
        } catch (_) {}

        try {
          await provider.call({
            to: gaugeAddr, from: wallet.address,
            data: GAUGE_IFACE.encodeFunctionData("withdraw", [tokenId]),
          });
        } catch (simErr) {
          throw new Error(`[sim withdraw tokenId=${tokenId}] ${simErr.shortMessage ?? simErr.message}`);
        }
        const tx = await wallet.sendTransaction({
          to: gaugeAddr,
          data: GAUGE_IFACE.encodeFunctionData("withdraw", [tokenId]),
        });
        await waitForTx(provider, tx);
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

        // Filtrer : seulement les positions de ce pool
        if (
          pos.token0.toLowerCase() !== WETH.toLowerCase() ||
          pos.token1.toLowerCase() !== stablecoin.toLowerCase()
        ) continue;

        // Rien à faire : position vide et sans fees
        if (pos.liquidity === 0n && pos.tokensOwed0 === 0n && pos.tokensOwed1 === 0n) continue;

        // Retirer toute la liquidité si > 0
        if (pos.liquidity > 0n) {
          const dlParams = {
            tokenId,
            liquidity:  pos.liquidity,
            amount0Min: 0n,
            amount1Min: 0n,
            deadline:   freshDeadline(),
          };
          // Simulation pour avoir le vrai revert
          try {
            await provider.call({
              to: NFPM, from: wallet.address,
              data: NFPM_IFACE.encodeFunctionData("decreaseLiquidity", [dlParams]),
            });
          } catch (simErr) {
            throw new Error(`[sim decreaseLiquidity tokenId=${tokenId}] ${simErr.shortMessage ?? simErr.message}`);
          }
          let gasLimit = 400000n;
          try {
            const est = await provider.estimateGas({ to: NFPM, from: wallet.address, data: NFPM_IFACE.encodeFunctionData("decreaseLiquidity", [dlParams]) });
            gasLimit = est * 3n / 2n;
          } catch (_) {}
          try {
            const tx = await wallet.sendTransaction({
              to: NFPM,
              data: NFPM_IFACE.encodeFunctionData("decreaseLiquidity", [dlParams]),
              gasLimit,
            });
            await waitForTx(provider, tx);
          } catch (e) { throw new Error(`[decreaseLiquidity tokenId=${tokenId}] ${e.message ?? e.shortMessage}`); }
        }

        // Collecter fees + tokens retirés
        try {
          const collectData = NFPM_IFACE.encodeFunctionData("collect", [{ tokenId, recipient: wallet.address, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }]);
          let collectGas = 200000n;
          try { const est = await provider.estimateGas({ to: NFPM, from: wallet.address, data: collectData }); collectGas = est * 3n / 2n; } catch (_) {}
          const tx = await wallet.sendTransaction({ to: NFPM, data: collectData, gasLimit: collectGas });
          await waitForTx(provider, tx);
          collectedList.push(tokenId.toString());
        } catch (e) {
          throw new Error(`[collect tokenId=${tokenId}] ${e.shortMessage ?? e.message}`);
        }
      }
    } catch (e) {
      throw new Error(e.message); // propage le message détaillé
    }

    // 4a. Swap AERO → WETH (récompenses du gauge)
    try {
      const aeroBalHex = await provider.call({
        to: AERO, data: ERC20_IFACE.encodeFunctionData("balanceOf", [wallet.address]),
      });
      const [aeroBal] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], aeroBalHex);

      if (aeroBal > 0n) {
        const txApp = await wallet.sendTransaction({
          to: AERO,
          data: ERC20_IFACE.encodeFunctionData("approve", [SWAP_ROUTER, ethers.MaxUint256]),
        });
        await waitForTx(provider, txApp);

        const aeroSwapParams = {
          tokenIn:           AERO,
          tokenOut:          WETH,
          tickSpacing:       200,
          recipient:         wallet.address,
          deadline:          freshDeadline(),
          amountIn:          aeroBal,
          amountOutMinimum:  0n,
          sqrtPriceLimitX96: 0n,
        };
        try {
          const txAeroSwap = await wallet.sendTransaction({
            to: SWAP_ROUTER,
            data: SWAP_ROUTER_IFACE.encodeFunctionData("exactInputSingle", [aeroSwapParams]),
          });
          await waitForTx(provider, txAeroSwap);
        } catch (e) { throw new Error(`[swap AERO→WETH] ${e.shortMessage ?? e.message}`); }
      }
    } catch (e) { throw new Error(`[étape 4a] ${e.message ?? e.shortMessage}`); }

    // 4. Swap tout le WETH → USDC
    let swapHash = null;
    try {
      const wethBalHex = await provider.call({
        to: WETH, data: ERC20_IFACE.encodeFunctionData("balanceOf", [wallet.address]),
      });
      const [wethBal] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], wethBalHex);

      if (wethBal > 0n) {
        try {
          const txApp = await wallet.sendTransaction({
            to: WETH,
            data: ERC20_IFACE.encodeFunctionData("approve", [SWAP_ROUTER, ethers.MaxUint256]),
          });
          await waitForTx(provider, txApp);
        } catch (e) { throw new Error(`[approve WETH→Router] ${e.shortMessage ?? e.message}`); }

        const swapParams = {
          tokenIn:           WETH,
          tokenOut:          stablecoin,
          tickSpacing,
          recipient:         wallet.address,
          deadline:          freshDeadline(),
          amountIn:          wethBal,
          amountOutMinimum:  0n,
          sqrtPriceLimitX96: 0n,
        };
        try {
          await provider.call({ to: SWAP_ROUTER, from: wallet.address, data: SWAP_ROUTER_IFACE.encodeFunctionData("exactInputSingle", [swapParams]) });
        } catch (simErr) { throw new Error(`[sim swap WETH→USDC wethBal=${wethBal} tickSpacing=${tickSpacing}] ${simErr.shortMessage ?? simErr.message}`); }
        try {
          const txSwap = await wallet.sendTransaction({
            to: SWAP_ROUTER,
            data: SWAP_ROUTER_IFACE.encodeFunctionData("exactInputSingle", [swapParams]),
          });
          swapHash = txSwap.hash;
          await waitForTx(provider, txSwap);
        } catch (e) { throw new Error(`[swap WETH→USDC] ${e.shortMessage ?? e.message}`); }
      }
    } catch (e) { throw new Error(`[étape 4] ${e.message ?? e.shortMessage}`); }

    // 5. Solde stablecoin final
    const stableBalHex = await provider.call({
      to: stablecoin, data: ERC20_IFACE.encodeFunctionData("balanceOf", [wallet.address]),
    });
    const [stableBal] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], stableBalHex);
    const finalUsdc  = Number(ethers.formatUnits(stableBal, 6)).toLocaleString("en-US", { minimumFractionDigits: 2 });

    return Response.json({
      message:   `Tout fermé. Solde final : $${finalUsdc}`,
      unstaked:  unstakedList,
      collected: collectedList,
      swapHash,
      finalUsdc,
    });

  } catch (e) {
    return Response.json({ error: e.message ?? e.shortMessage }, { status: 500 });
  }
}
