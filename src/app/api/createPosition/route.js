import { ethers } from "ethers";
import { neon }   from "@neondatabase/serverless";

export const runtime     = "nodejs";
export const maxDuration = 300;

const sql = neon(process.env.DATABASE_URL);

async function logEvent(fields) {
  try {
    await sql`INSERT INTO lp_events
      (action, usdc_placed, range_min, range_max, range_pct, usdc_remaining, token_id, error_msg, usdc_on_close)
      VALUES (${fields.action}, ${fields.usdc_placed ?? null}, ${fields.range_min ?? null},
              ${fields.range_max ?? null}, ${fields.range_pct ?? null},
              ${fields.usdc_remaining ?? null}, ${fields.token_id ?? null}, ${fields.error_msg ?? null},
              ${fields.usdc_on_close ?? null})`;
  } catch (_) {}
}

const NFPM        = "0x827922686190790b37229fd06084350E74485b72";
const SWAP_ROUTER = "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5"; // Aerodrome Slipstream SwapRouter (Initial Deployment, même que NFPM)
const WETH        = "0x4200000000000000000000000000000000000006";
const USDC        = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const POOL        = "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";
const VOTER       = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";

function optimalWethFraction(price, minPrice, maxPrice) {
  if (price <= minPrice) return 1;
  if (price >= maxPrice) return 0;
  const sqrtP  = Math.sqrt(price);
  const sqrtPa = Math.sqrt(minPrice);
  const sqrtPb = Math.sqrt(maxPrice);
  const val0 = sqrtP - price / sqrtPb;
  const val1 = sqrtP - sqrtPa;
  if (val0 + val1 <= 0) return 0.5;
  return val0 / (val0 + val1);
}

// Trouve le centre du range tel que optimalWethFraction(P, C/(1+h), C*(1+h)) = targetRatio
function findCenterForRatio(targetRatio, P, halfFrac) {
  const h = halfFrac;
  if (targetRatio >= 1) return P * (1 + h);
  if (targetRatio <= 0) return P / (1 + h);
  let lo = P / (1 + h) * 1.0001;
  let hi = P * (1 + h) * 0.9999;
  for (let i = 0; i < 60; i++) {
    const C = Math.sqrt(lo * hi);
    const r = optimalWethFraction(P, C / (1 + h), C * (1 + h));
    if (r < targetRatio) lo = C;
    else hi = C;
  }
  return Math.sqrt(lo * hi);
}

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

// tx.wait() échoue souvent sur Base RPCs même quand la tx réussit → fallback par polling
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
  await waitForTx(provider, tx);
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

function roundTickFloor(tick, spacing) {
  return Math.floor(tick / spacing) * spacing;
}

function roundTickCeil(tick, spacing) {
  return Math.ceil(tick / spacing) * spacing;
}

// Prix USDC/WETH à partir du tick exact (inverse de priceToTick)
function tickToPrice(tick) {
  return Math.pow(1.0001, tick) * Math.pow(10, -DECIMAL_ADJUSTMENT);
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
  const { amountUSDC, minPrice, maxPrice, currentPrice, targetRatio } = await req.json();
  if (!amountUSDC || !minPrice || !maxPrice || !currentPrice)
    return Response.json({ error: "Paramètres manquants" }, { status: 400 });

  try {
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) return Response.json({ error: "PRIVATE_KEY manquant dans .env.local" }, { status: 500 });

    const rpcUrl   = await pickRpc();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet   = new ethers.Wallet(privateKey, provider);

    // 1. tickSpacing + prix réel du pool (slot0)
    const tsRaw = await provider.call({ to: POOL, data: "0xd0c93a7c" });
    const tickSpacing = Number(ethers.toBigInt(tsRaw));

    // Prix on-chain depuis sqrtPriceX96 — plus précis que le feed UI, critique pour les ranges serrés
    let poolPrice = currentPrice;
    try {
      const slot0Hex = await provider.call({ to: POOL, data: "0x3850c7bd" }); // slot0()
      const sqrtPriceX96 = ethers.AbiCoder.defaultAbiCoder().decode(["uint160"], slot0Hex)[0];
      // sqrtPrice = sqrtPriceX96 / 2^96 ; price_raw = sqrtPrice^2 ; human = price_raw * 10^12
      const sqrtP = Number(sqrtPriceX96) / Number(2n ** 96n);
      poolPrice = sqrtP * sqrtP * 1e12;
    } catch (_) { /* fallback au prix UI */ }

    // 2. Re-centrer le range sur le prix pool réel (corrige le lag UI → exécution)
    //    puis essayer les 4 combinaisons d'arrondi pour minimiser le biais de tick spacing
    const halfFrac      = Math.sqrt(maxPrice / minPrice) - 1;
    const serverCenter  = findCenterForRatio(targetRatio ?? 0.5, poolPrice, halfFrac);
    const serverMin     = serverCenter / (1 + halfFrac);
    const serverMax     = serverCenter * (1 + halfFrac);

    const rawLower = priceToTick(serverMin);
    const rawUpper = priceToTick(serverMax);

    let tickLower = roundTickFloor(rawLower, tickSpacing);
    let tickUpper = roundTickCeil(rawUpper, tickSpacing);
    let bestMidErr = Math.abs(Math.sqrt(tickToPrice(tickLower) * tickToPrice(tickUpper)) - serverCenter);

    for (const [lo, hi] of [
      [roundTickCeil(rawLower,  tickSpacing), roundTickCeil(rawUpper,  tickSpacing)],
      [roundTickFloor(rawLower, tickSpacing), roundTickFloor(rawUpper, tickSpacing)],
      [roundTickCeil(rawLower,  tickSpacing), roundTickFloor(rawUpper, tickSpacing)],
    ]) {
      if (lo >= hi) continue;
      const err = Math.abs(Math.sqrt(tickToPrice(lo) * tickToPrice(hi)) - serverCenter);
      if (err < bestMidErr) { bestMidErr = err; tickLower = lo; tickUpper = hi; }
    }

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

    // 4. Lire les soldes réels avant swap
    const readBal = async (token) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const h = await provider.call({ to: token, data: ERC20_IFACE.encodeFunctionData("balanceOf", [wallet.address]) });
          if (h && h !== "0x") return ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], h)[0];
        } catch (_) {}
        await new Promise(r => setTimeout(r, 1500));
      }
      throw new Error(`balanceOf(${token}) échoué après 3 tentatives`);
    };

    let usdcBalBefore, wethBalBefore;
    try {
      usdcBalBefore = await readBal(USDC);
      wethBalBefore = await readBal(WETH);
    } catch (e) { throw new Error(`[étape 4 – lecture soldes] ${e.shortMessage ?? e.message}`); }

    // Budget total disponible = USDC + valeur du WETH déjà en wallet
    const wethValueUsdc = Number(ethers.formatUnits(wethBalBefore, 18)) * poolPrice;
    const usdcAvailable = Number(ethers.formatUnits(usdcBalBefore, 6));
    const totalAvailable = usdcAvailable + wethValueUsdc;

    if (totalAvailable < 1)
      return Response.json({ error: `Solde insuffisant : ${usdcAvailable.toFixed(2)} USDC + ${wethValueUsdc.toFixed(2)}$ de WETH` }, { status: 400 });

    // Budget effectif plafonné à ce qu'on a
    const totalBudget       = Math.min(amountUSDC, totalAvailable);
    // Utiliser les prix des ticks réels (après arrondi) et non les prix user — évite le désalignement ratio
    const tickLowerPrice    = tickToPrice(tickLower);
    const tickUpperPrice    = tickToPrice(tickUpper);
    const swapRatio = optimalWethFraction(poolPrice, tickLowerPrice, tickUpperPrice);
    const targetWethValue   = totalBudget * swapRatio; // valeur WETH cible en $

    // Swap seulement le manque de WETH — si on en a déjà assez, on ne swap pas
    const wethDeficitUsdc = Math.max(0, targetWethValue - wethValueUsdc);
    const usdcToSwap = wethDeficitUsdc > 0.01
      ? ethers.parseUnits(String(Math.min(wethDeficitUsdc, usdcAvailable).toFixed(6)), 6)
      : 0n;

    // 5. Approve USDC → SwapRouter (seulement si on a quelque chose à swapper)
    if (usdcToSwap > 0n) {
      try {
        await ensureAllowance(wallet, provider, USDC, SWAP_ROUTER, usdcToSwap);
      } catch (e) { throw new Error(`[étape 5 – approve USDC→Router] ${e.shortMessage ?? e.message}`); }
    }

    // 6. Swap USDC → WETH
    let txSwapHash = null;
    if (usdcToSwap > 0n) {
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
        await waitForTx(provider, txSwap);
      } catch (e) { throw new Error(`[étape 6 – swap USDC→WETH] ${e.shortMessage ?? e.message}`); }
    }

    // 7. Soldes réels après swap
    let wethBalance, usdcBalance;
    try {
      wethBalance = await readBal(WETH);
      usdcBalance = await readBal(USDC);
    } catch (e) { throw new Error(`[étape 7 – lecture soldes post-swap] ${e.shortMessage ?? e.message}`); }

    // USDC pour le LP = plafonné à la part USDC du budget
    const usdcBudgeted = ethers.parseUnits(String((totalBudget * (1 - swapRatio)).toFixed(6)), 6);
    const usdcToKeep   = usdcBalance < usdcBudgeted ? usdcBalance : usdcBudgeted;

    // WETH pour le LP = plafonné à la part WETH du budget (même logique que USDC)
    const wethBudgeted = ethers.parseUnits(String((targetWethValue / poolPrice).toFixed(18)), 18);
    const wethToUse    = wethBalance < wethBudgeted ? wethBalance : wethBudgeted;

    // 8. Approve WETH + USDC → NFPM (seulement si insuffisant)
    try {
      await ensureAllowance(wallet, provider, WETH, NFPM, wethToUse);
    } catch (e) { throw new Error(`[étape 8a – approve WETH→NFPM] ${e.shortMessage ?? e.message}`); }

    try {
      await ensureAllowance(wallet, provider, USDC, NFPM, usdcToKeep);
    } catch (e) { throw new Error(`[étape 8b – approve USDC→NFPM] ${e.shortMessage ?? e.message}`); }

    // 9. Mint position
    const mintParams = {
      token0:         WETH,
      token1:         USDC,
      tickSpacing,
      tickLower,
      tickUpper,
      amount0Desired: wethToUse,
      amount1Desired: usdcToKeep,
      amount0Min:     0n,
      amount1Min:     0n,
      recipient:      wallet.address,
      deadline:       freshDeadline(),
      sqrtPriceX96:   0n,
    };
    const mintDiag = `tickLower=${tickLower} tickUpper=${tickUpper} tickSpacing=${tickSpacing} amount0=${wethBalance} amount1=${usdcToKeep} swapRatio=${swapRatio.toFixed(4)} poolPrice=${poolPrice.toFixed(2)} usdcToSwap=${usdcToSwap} wethBefore=${wethBalBefore} wethDeficit=${wethDeficitUsdc.toFixed(2)}`;

    // Simulation avant envoi pour avoir le vrai message d'erreur
    try {
      await provider.call({ to: NFPM, from: wallet.address, data: NFPM_IFACE.encodeFunctionData("mint", [mintParams]) });
    } catch (simErr) {
      throw new Error(`[simulation mint] ${simErr.shortMessage ?? simErr.message} | ${mintDiag}`);
    }

    let mintTxHash = null;
    let tokenId = null;
    try {
      // Estimer le gas + marge ×1.5 pour éviter les out-of-gas sur NFPM Aerodrome
      let gasLimit = 600000n;
      try {
        const est = await provider.estimateGas({ to: NFPM, from: wallet.address, data: NFPM_IFACE.encodeFunctionData("mint", [mintParams]) });
        gasLimit = est * 3n / 2n;
      } catch (_) {}

      const mintTx = await wallet.sendTransaction({
        to: NFPM,
        data: NFPM_IFACE.encodeFunctionData("mint", [mintParams]),
        gasLimit,
      });
      mintTxHash = mintTx.hash;
      const receipt = await waitForTx(provider, mintTx);
      const log = receipt.logs.find(l =>
        l.address.toLowerCase() === NFPM.toLowerCase() &&
        l.topics.length === 4 &&
        l.topics[0] === TRANSFER_TOPIC &&
        l.topics[1] === "0x0000000000000000000000000000000000000000000000000000000000000000"
      );
      if (log) tokenId = ethers.toBigInt(log.topics[3]);
    } catch (e) { throw new Error(`[étape 9 – mint] ${e.shortMessage ?? e.message} | ${mintDiag}`); }

    if (tokenId == null)
      throw new Error("[étape 9 – mint] Transfer event introuvable dans le reçu");

    // 10. Sweep WETH résiduel → USDC (le LP n'utilise pas forcément tout le WETH)
    let sweepWarning = null;
    try {
      const wethRem = await readBal(WETH);
      if (wethRem > 0n) {
        await ensureAllowance(wallet, provider, WETH, SWAP_ROUTER, wethRem);
        const txSweep = await wallet.sendTransaction({
          to: SWAP_ROUTER,
          data: SWAP_ROUTER_IFACE.encodeFunctionData("exactInputSingle", [{
            tokenIn:           WETH,
            tokenOut:          USDC,
            tickSpacing,
            recipient:         wallet.address,
            deadline:          freshDeadline(),
            amountIn:          wethRem,
            amountOutMinimum:  0n,
            sqrtPriceLimitX96: 0n,
          }]),
        });
        await waitForTx(provider, txSweep);
      }
    } catch (e) {
      sweepWarning = `WETH résiduel non converti : ${e.shortMessage ?? e.message}`;
    }

    // 11. Double approbation : approve(tokenId) + setApprovalForAll pour couvrir les deux cas
    try {
      const txApproveId = await wallet.sendTransaction({
        to: NFPM,
        data: NFPM_IFACE.encodeFunctionData("approve", [gaugeAddr, tokenId]),
      });
      await waitForTx(provider, txApproveId);
    } catch (e) { throw new Error(`[étape 11a – approve tokenId] ${e.shortMessage ?? e.message}`); }

    try {
      let needsApproval = true;
      try {
        const approvedHex = await provider.call({
          to: NFPM,
          data: NFPM_IFACE.encodeFunctionData("isApprovedForAll", [wallet.address, gaugeAddr]),
        });
        const [alreadyAll] = ethers.AbiCoder.defaultAbiCoder().decode(["bool"], approvedHex);
        needsApproval = !alreadyAll;
      } catch (_) { /* RPC transient — on envoie setApprovalForAll par précaution */ }

      if (needsApproval) {
        const txAll = await wallet.sendTransaction({
          to: NFPM,
          data: NFPM_IFACE.encodeFunctionData("setApprovalForAll", [gaugeAddr, true]),
        });
        await waitForTx(provider, txAll);
      }
    } catch (e) { throw new Error(`[étape 11b – setApprovalForAll] ${e.shortMessage ?? e.message}`); }

    // 12. Dépôt dans le gauge
    // Simulation pour capturer le vrai message de revert avant d'envoyer la tx
    try {
      await provider.call({ to: gaugeAddr, from: wallet.address, data: GAUGE_IFACE.encodeFunctionData("deposit", [tokenId]) });
    } catch (simErr) {
      throw new Error(`[simulation deposit] ${simErr.shortMessage ?? simErr.message} | tokenId=${tokenId} gauge=${gaugeAddr}`);
    }

    let txGaugeHash = null;
    try {
      const depositData = GAUGE_IFACE.encodeFunctionData("deposit", [tokenId]);
      let gaugeGas = 300000n;
      try { const est = await provider.estimateGas({ to: gaugeAddr, from: wallet.address, data: depositData }); gaugeGas = est * 3n / 2n; } catch (_) {}
      const txGauge = await wallet.sendTransaction({ to: gaugeAddr, data: depositData, gasLimit: gaugeGas });
      txGaugeHash = txGauge.hash;
      await waitForTx(provider, txGauge);
    } catch (e) { throw new Error(`[étape 12 – deposit gauge] tokenId=${tokenId} | ${e.message ?? e.shortMessage}`); }

    const budgetWarning = totalBudget < amountUSDC
      ? `⚠ Budget plafonné à $${totalBudget.toFixed(2)} (demandé $${amountUSDC}, disponible $${totalAvailable.toFixed(2)})`
      : null;

    const payload = {
      message:    `Position #${tokenId} créée — LP ${Math.round(swapRatio*100)}% WETH / ${Math.round((1-swapRatio)*100)}% USDC · range $${tickLowerPrice.toFixed(0)}→$${tickUpperPrice.toFixed(0)}`,
      tokenId:    tokenId.toString(),
      txSwap:     txSwapHash,
      txMint:     mintTxHash,
      txGauge:    txGaugeHash,
      budgetUsed: `$${totalBudget.toFixed(2)} / $${amountUSDC} demandés`,
      detail: {
        totalBudget:    totalBudget.toFixed(2),
        swapRatio:      swapRatio.toFixed(4),
        tickPrices:     `$${tickLowerPrice.toFixed(2)}→$${tickUpperPrice.toFixed(2)}`,
        wethInLP:       ethers.formatUnits(wethBalance, 18),
        usdcInLP:       ethers.formatUnits(usdcToKeep, 6),
        usdcAvailable:  usdcAvailable.toFixed(2),
        wethValueUsdc:  wethValueUsdc.toFixed(2),
      },
      ...(budgetWarning  ? { warning: budgetWarning }   : {}),
      ...(sweepWarning   ? { sweepWarning }              : {}),
    };

    const rangePct = ((maxPrice / minPrice - 1) * 100).toFixed(2);
    try {
      const usdcRestant = Number(ethers.formatUnits(await readBal(USDC), 6));
      const usdcPlaced  = usdcAvailable - usdcRestant;
      await logEvent({
        action:         "CREATE_OK",
        usdc_placed:    usdcPlaced.toFixed(2),
        range_min:      minPrice,
        range_max:      maxPrice,
        range_pct:      rangePct,
        usdc_remaining: usdcRestant.toFixed(2),
        token_id:       tokenId.toString(),
      });
    } catch (_) {}

    return Response.json(payload);

  } catch (e) {
    const msg = e.message ?? e.shortMessage ?? String(e);
    const rangePct = minPrice && maxPrice ? ((maxPrice / minPrice - 1) * 100).toFixed(2) : null;
    await logEvent({
      action:    "CREATE_ERR",
      usdc_placed: amountUSDC ?? null,
      range_min: minPrice ?? null,
      range_max: maxPrice ?? null,
      range_pct: rangePct,
      error_msg: msg,
    });
    return Response.json({ error: msg }, { status: 500 });
  }
}
