import { ethers } from "ethers";

export const runtime     = "nodejs";
export const maxDuration = 300;

const NFPM        = "0x827922686190790b37229fd06084350E74485b72";
const SWAP_ROUTER = "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5"; // Aerodrome Slipstream SwapRouter (Initial Deployment, même que NFPM)
const WETH        = "0x4200000000000000000000000000000000000006";
const USDC        = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const POOL        = "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";
const VOTER       = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";

// Fraction du budget USDC swappée en WETH (0.5 = 50/50)
const SWAP_RATIO = 0.5;

const RPC_URLS = [
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
];

const ERC20_IFACE = new ethers.Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

async function ensureAllowance(wallet, provider, token, spender, amount) {
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000));
    const data    = ERC20_IFACE.encodeFunctionData("allowance", [wallet.address, spender]);
    const hex     = await Promise.race([provider.call({ to: token, data }), timeout]);
    const [current] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], hex);
    if (current >= amount) return null; // déjà approuvé, pas de tx
  } catch (_) {
    // timeout ou erreur RPC → on envoie l'approve quand même
  }
  const tx = await wallet.sendTransaction({
    to: token,
    data: ERC20_IFACE.encodeFunctionData("approve", [spender, ethers.MaxUint256]),
  });
  await tx.wait();
  return tx.hash;
}

const SWAP_ROUTER_IFACE = new ethers.Interface([
  "function exactInputSingle((address tokenIn, address tokenOut, int24 tickSpacing, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut)",
]);

const NFPM_IFACE = new ethers.Interface([
  "function mint((address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline, uint160 sqrtPriceX96) params) returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function approve(address to, uint256 tokenId)",
  "function setApprovalForAll(address operator, bool approved)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
]);

const GAUGE_IFACE = new ethers.Interface([
  "function deposit(uint256 tokenId)",
]);

const VOTER_IFACE = new ethers.Interface([
  "function gauges(address pool) view returns (address)",
]);

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// token0=WETH (18 dec), token1=USDC (6 dec) → rawPrice = humanPrice × 10^(6−18)
const DECIMAL_ADJUSTMENT = 6 - 18;

function priceToTick(price) {
  const rawPrice = price * Math.pow(10, DECIMAL_ADJUSTMENT);
  return Math.floor(Math.log(rawPrice) / Math.log(1.0001));
}

function roundTick(tick, spacing) {
  return Math.round(tick / spacing) * spacing;
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

export async function POST(req) {
  const { amountUSDC, minPrice, maxPrice, currentPrice } = await req.json();
  if (!amountUSDC || !minPrice || !maxPrice || !currentPrice)
    return Response.json({ error: "Paramètres manquants" }, { status: 400 });

  try {
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) return Response.json({ error: "PRIVATE_KEY manquant dans .env.local" }, { status: 500 });

    const rpcUrl   = await pickRpc();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet   = new ethers.Wallet(privateKey, provider);

    // 1. tickSpacing du pool
    const tsRaw = await provider.call({ to: POOL, data: "0xd0c93a7c" });
    const tickSpacing = Number(ethers.toBigInt(tsRaw));

    // 2. Ticks arrondis
    const tickLower = roundTick(priceToTick(minPrice), tickSpacing);
    const tickUpper = roundTick(priceToTick(maxPrice), tickSpacing);
    if (tickLower >= tickUpper)
      return Response.json({ error: `Range invalide : tickLower(${tickLower}) >= tickUpper(${tickUpper}) — élargis la fourchette de prix` }, { status: 400 });

    // 3. Adresse du gauge via Voter
    const gaugeResult = await provider.call({
      to: VOTER,
      data: VOTER_IFACE.encodeFunctionData("gauges", [POOL]),
    });
    const [gaugeAddr] = ethers.AbiCoder.defaultAbiCoder().decode(["address"], gaugeResult);
    if (!gaugeAddr || gaugeAddr === ethers.ZeroAddress)
      return Response.json({ error: "Gauge introuvable pour ce pool" }, { status: 500 });

    const freshDeadline = () => Math.floor(Date.now() / 1000) + 600;

    // 4. Calcul des montants : SWAP_RATIO du budget en USDC swappé vers WETH
    const usdcToSwap = ethers.parseUnits(String((amountUSDC * SWAP_RATIO).toFixed(6)), 6);
    const usdcToKeep = ethers.parseUnits(String((amountUSDC * (1 - SWAP_RATIO)).toFixed(6)), 6);

    // 5. Approve USDC → SwapRouter (seulement si insuffisant)
    try {
      await ensureAllowance(wallet, provider, USDC, SWAP_ROUTER, usdcToSwap);
    } catch (e) { throw new Error(`[étape 5 – approve USDC→Router] ${e.shortMessage ?? e.message}`); }

    // 6. Swap USDC → WETH
    let txSwapHash = null;
    try {
      const txSwap = await wallet.sendTransaction({
        to: SWAP_ROUTER,
        data: SWAP_ROUTER_IFACE.encodeFunctionData("exactInputSingle", [{
          tokenIn:            USDC,
          tokenOut:           WETH,
          tickSpacing,
          recipient:          wallet.address,
          deadline:           freshDeadline(),
          amountIn:           usdcToSwap,
          amountOutMinimum:   0n,
          sqrtPriceLimitX96:  0n,
        }]),
      });
      txSwapHash = txSwap.hash;
      await txSwap.wait();
    } catch (e) { throw new Error(`[étape 6 – swap USDC→WETH] ${e.shortMessage ?? e.message}`); }

    // 7. Lire le solde WETH reçu
    const wethBalanceHex = await provider.call({
      to:   WETH,
      data: ERC20_IFACE.encodeFunctionData("balanceOf", [wallet.address]),
    });
    const wethBalance = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], wethBalanceHex)[0];

    // 8. Approve WETH + USDC → NFPM (seulement si insuffisant)
    try {
      await ensureAllowance(wallet, provider, WETH, NFPM, wethBalance);
    } catch (e) { throw new Error(`[étape 8a – approve WETH→NFPM] ${e.shortMessage ?? e.message}`); }

    try {
      await ensureAllowance(wallet, provider, USDC, NFPM, usdcToKeep);
    } catch (e) { throw new Error(`[étape 8b – approve USDC→NFPM] ${e.shortMessage ?? e.message}`); }

    // 9. Mint position
    let mintTxHash = null;
    let tokenId = null;
    try {
      const mintTx = await wallet.sendTransaction({
        to: NFPM,
        data: NFPM_IFACE.encodeFunctionData("mint", [{
          token0:         WETH,
          token1:         USDC,
          tickSpacing,
          tickLower,
          tickUpper,
          amount0Desired: wethBalance,
          amount1Desired: usdcToKeep,
          amount0Min:     0n,
          amount1Min:     0n,
          recipient:      wallet.address,
          deadline:       freshDeadline(),
          sqrtPriceX96:   0n,
        }]),
      });
      mintTxHash = mintTx.hash;
      let receipt = null;
      try { receipt = await mintTx.wait(); } catch (_) {}
      // Si wait() a échoué, on relit le reçu directement
      if (!receipt) receipt = await provider.getTransactionReceipt(mintTxHash);
      if (!receipt) throw new Error("reçu introuvable après mint");
      if (receipt.status === 0) throw new Error("mint rejeté on-chain (status=0)");
      const log = receipt.logs.find(l =>
        l.address.toLowerCase() === NFPM.toLowerCase() &&
        l.topics.length === 4 &&
        l.topics[0] === TRANSFER_TOPIC &&
        l.topics[1] === "0x0000000000000000000000000000000000000000000000000000000000000000"
      );
      if (log) tokenId = ethers.toBigInt(log.topics[3]);
    } catch (e) { throw new Error(`[étape 9 – mint] ${e.shortMessage ?? e.message}`); }

    if (tokenId == null)
      throw new Error("[étape 9 – mint] Transfer event introuvable dans le reçu");

    const ownerIface = new ethers.Interface(["function ownerOf(uint256 tokenId) view returns (address)"]);

    // 11. Double approbation : approve(tokenId) + setApprovalForAll pour couvrir les deux cas
    try {
      const txApproveId = await wallet.sendTransaction({
        to: NFPM,
        data: NFPM_IFACE.encodeFunctionData("approve", [gaugeAddr, tokenId]),
      });
      await txApproveId.wait();
    } catch (e) { throw new Error(`[étape 11a – approve tokenId] ${e.shortMessage ?? e.message}`); }

    try {
      const approvedHex = await provider.call({
        to: NFPM,
        data: NFPM_IFACE.encodeFunctionData("isApprovedForAll", [wallet.address, gaugeAddr]),
      });
      const [alreadyAll] = ethers.AbiCoder.defaultAbiCoder().decode(["bool"], approvedHex);
      if (!alreadyAll) {
        const txAll = await wallet.sendTransaction({
          to: NFPM,
          data: NFPM_IFACE.encodeFunctionData("setApprovalForAll", [gaugeAddr, true]),
        });
        await txAll.wait();
      }
    } catch (e) { throw new Error(`[étape 11b – setApprovalForAll] ${e.shortMessage ?? e.message}`); }

    // 12. Dépôt dans le gauge
    let txGaugeHash = null;
    try {
      const txGauge = await wallet.sendTransaction({
        to: gaugeAddr,
        data: GAUGE_IFACE.encodeFunctionData("deposit", [tokenId]),
      });
      txGaugeHash = txGauge.hash;
      await txGauge.wait();
    } catch (e) {
      // Vérifie on-chain si le dépôt a quand même réussi (ethers.js peut mal lire le reçu)
      const ownerHex2 = await provider.call({ to: NFPM, data: ownerIface.encodeFunctionData("ownerOf", [tokenId]) });
      const [ownerAfter] = ethers.AbiCoder.defaultAbiCoder().decode(["address"], ownerHex2);
      if (ownerAfter.toLowerCase() !== gaugeAddr.toLowerCase())
        throw new Error(`[étape 12 – deposit gauge] tokenId=${tokenId} | ${e.shortMessage ?? e.message}`);
      // Le gauge possède le token → dépôt réussi malgré l'erreur ethers.js
    }

    return Response.json({
      message:  `Position #${tokenId} créée et stakée — range $${minPrice}→$${maxPrice}`,
      tokenId:  tokenId.toString(),
      txSwap:   txSwapHash,
      txMint:   mintTxHash,
      txGauge:  txGaugeHash,
    });

  } catch (e) {
    return Response.json({ error: e.shortMessage ?? e.message }, { status: 500 });
  }
}
