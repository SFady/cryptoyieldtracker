import { ethers } from "ethers";

export const runtime     = "nodejs";
export const maxDuration = 300;

const NFPM       = "0x827922686190790b37229fd06084350E74485b72";
const CL_ROUTER  = "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5";
const V2_ROUTER  = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const V2_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
const WETH       = "0x4200000000000000000000000000000000000006";
const USDC       = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const AERO       = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const POOL       = "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";
const VOTER      = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";

const MAX_UINT128 = (1n << 128n) - 1n;

const RPC_URLS = [
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
];

const ERC20_IFACE = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

const NFPM_IFACE = new ethers.Interface([
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)",
  "function approve(address to, uint256 tokenId)",
  "function setApprovalForAll(address operator, bool approved)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
]);

const GAUGE_IFACE = new ethers.Interface([
  "function withdraw(uint256 tokenId)",
  "function getReward(uint256 tokenId)",
  "function deposit(uint256 tokenId)",
]);

const VOTER_IFACE = new ethers.Interface([
  "function gauges(address pool) view returns (address)",
]);

const CL_ROUTER_IFACE = new ethers.Interface([
  "function exactInputSingle((address tokenIn, address tokenOut, int24 tickSpacing, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut)",
]);

const V2_ROUTER_IFACE = new ethers.Interface([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)",
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

export async function POST(req) {
  const { tokenId: tokenIdStr } = await req.json();
  if (!tokenIdStr) return Response.json({ error: "tokenId manquant" }, { status: 400 });
  const tokenId = BigInt(tokenIdStr);

  try {
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) return Response.json({ error: "PRIVATE_KEY manquant" }, { status: 500 });

    const rpcUrl   = await pickRpc();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet   = new ethers.Wallet(privateKey, provider);
    const freshDeadline = () => Math.floor(Date.now() / 1000) + 600;

    const readBal = async (token) => {
      const h = await provider.call({ to: token, data: ERC20_IFACE.encodeFunctionData("balanceOf", [wallet.address]) });
      return ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], h)[0];
    };

    // 1. Gauge + tickSpacing
    const [gaugeAddr] = await view(provider, VOTER, VOTER_IFACE, "gauges", [POOL]);
    if (!gaugeAddr || gaugeAddr === ethers.ZeroAddress)
      return Response.json({ error: "Gauge introuvable" }, { status: 500 });

    const tsRaw      = await provider.call({ to: POOL, data: "0xd0c93a7c" });
    const tickSpacing = Number(ethers.toBigInt(tsRaw));

    // 2. Claim AERO (pendant que la position est encore stakée)
    try {
      const tx = await wallet.sendTransaction({
        to: gaugeAddr,
        data: GAUGE_IFACE.encodeFunctionData("getReward", [tokenId]),
      });
      await waitForTx(provider, tx);
    } catch (_) {}

    // 3. Unstake
    try {
      await provider.call({
        to: gaugeAddr, from: wallet.address,
        data: GAUGE_IFACE.encodeFunctionData("withdraw", [tokenId]),
      });
    } catch (simErr) {
      throw new Error(`[sim withdraw] ${simErr.shortMessage ?? simErr.message}`);
    }
    const txWithdraw = await wallet.sendTransaction({
      to: gaugeAddr,
      data: GAUGE_IFACE.encodeFunctionData("withdraw", [tokenId]),
    });
    await waitForTx(provider, txWithdraw);

    // 4. Collect fees LP
    const collectData = NFPM_IFACE.encodeFunctionData("collect", [{
      tokenId, recipient: wallet.address, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128,
    }]);
    let collectGas = 200000n;
    try { const est = await provider.estimateGas({ to: NFPM, from: wallet.address, data: collectData }); collectGas = est * 3n / 2n; } catch (_) {}
    const txCollect = await wallet.sendTransaction({ to: NFPM, data: collectData, gasLimit: collectGas });
    await waitForTx(provider, txCollect);

    // 5. Re-staker
    const txApproveId = await wallet.sendTransaction({
      to: NFPM,
      data: NFPM_IFACE.encodeFunctionData("approve", [gaugeAddr, tokenId]),
    });
    await waitForTx(provider, txApproveId);

    let needsApprovalAll = true;
    try {
      const approvedHex = await provider.call({
        to: NFPM,
        data: NFPM_IFACE.encodeFunctionData("isApprovedForAll", [wallet.address, gaugeAddr]),
      });
      const [alreadyAll] = ethers.AbiCoder.defaultAbiCoder().decode(["bool"], approvedHex);
      needsApprovalAll = !alreadyAll;
    } catch (_) { /* RPC transient — on envoie setApprovalForAll par précaution */ }

    if (needsApprovalAll) {
      const txAll = await wallet.sendTransaction({
        to: NFPM,
        data: NFPM_IFACE.encodeFunctionData("setApprovalForAll", [gaugeAddr, true]),
      });
      await waitForTx(provider, txAll);
    }

    // Simulation avant dépôt
    try {
      await provider.call({ to: gaugeAddr, from: wallet.address, data: GAUGE_IFACE.encodeFunctionData("deposit", [tokenId]) });
    } catch (simErr) {
      const msg = simErr.shortMessage ?? simErr.message ?? "";
      if (msg && !msg.includes("missing revert data")) {
        throw new Error(`[sim deposit] ${msg}`);
      }
    }
    let depositGas = 300000n;
    try { const est = await provider.estimateGas({ to: gaugeAddr, from: wallet.address, data: GAUGE_IFACE.encodeFunctionData("deposit", [tokenId]) }); depositGas = est * 3n / 2n; } catch (_) {}
    const txDeposit = await wallet.sendTransaction({
      to: gaugeAddr,
      data: GAUGE_IFACE.encodeFunctionData("deposit", [tokenId]),
      gasLimit: depositGas,
    });
    await waitForTx(provider, txDeposit);

    // 6. Swap WETH → USDC
    const usdcBeforeSwaps = await readBal(USDC).catch(() => 0n);
    let wethSwapHash = null;
    const wethBal = await readBal(WETH);
    if (wethBal > 0n) {
      try {
        const txApp = await wallet.sendTransaction({
          to: WETH,
          data: ERC20_IFACE.encodeFunctionData("approve", [CL_ROUTER, ethers.MaxUint256]),
        });
        await waitForTx(provider, txApp);
        const txSwap = await wallet.sendTransaction({
          to: CL_ROUTER,
          data: CL_ROUTER_IFACE.encodeFunctionData("exactInputSingle", [{
            tokenIn: WETH, tokenOut: USDC, tickSpacing,
            recipient: wallet.address, deadline: freshDeadline(),
            amountIn: wethBal, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
          }]),
        });
        wethSwapHash = txSwap.hash;
        await waitForTx(provider, txSwap);
      } catch (e) { throw new Error(`[swap WETH→USDC] ${e.message ?? e.shortMessage}`); }
    }

    // 7. Swap AERO → USDC (V2 router, gracieux si le pool n'existe pas)
    let aeroSwapHash = null;
    try {
      const aeroBal = await readBal(AERO);
      if (aeroBal > 0n) {
        const txAeroApp = await wallet.sendTransaction({
          to: AERO,
          data: ERC20_IFACE.encodeFunctionData("approve", [V2_ROUTER, ethers.MaxUint256]),
        });
        await waitForTx(provider, txAeroApp);
        const routes = [{ from: AERO, to: USDC, stable: false, factory: V2_FACTORY }];
        const swapData = V2_ROUTER_IFACE.encodeFunctionData("swapExactTokensForTokens", [
          aeroBal, 0n, routes, wallet.address, freshDeadline(),
        ]);
        await provider.call({ to: V2_ROUTER, from: wallet.address, data: swapData });
        const txAeroSwap = await wallet.sendTransaction({ to: V2_ROUTER, data: swapData });
        aeroSwapHash = txAeroSwap.hash;
        await waitForTx(provider, txAeroSwap);
      }
    } catch (_) {}

    // 8. Transfert des fees converties vers DESTINATION_WALLET
    try {
      const dest = process.env.DESTINATION_WALLET;
      if (dest) {
        const usdcAfterSwaps = await readBal(USDC);
        const delta = usdcAfterSwaps > usdcBeforeSwaps ? usdcAfterSwaps - usdcBeforeSwaps : 0n;
        if (delta > 0n) {
          await wallet.sendTransaction({
            to: USDC,
            data: ERC20_IFACE.encodeFunctionData("transfer", [dest, delta]),
          });
        }
      }
    } catch (_) {}

    // 9. Solde USDC final
    const usdcBal = await readBal(USDC);
    const finalUsdc = Number(ethers.formatUnits(usdcBal, 6)).toFixed(2);

    return Response.json({ success: true, finalUsdc, wethSwapHash, aeroSwapHash });

  } catch (e) {
    return Response.json({ error: e.message ?? e.shortMessage }, { status: 500 });
  }
}
