import { ethers } from "ethers";
import { neon }   from "@neondatabase/serverless";

export const runtime     = "nodejs";
export const maxDuration = 300;

const sql = neon(process.env.DATABASE_URL);

async function logEvent(fields) {
  try {
    await sql`INSERT INTO lp_events
      (action1, action2, usdc_placed, range_min, range_max, range_pct, usdc_remaining, token_id, error_msg, usdc_on_close, pool_num, weth, usdc, type)
      VALUES (${fields.action1}, ${fields.action2 ?? null}, ${fields.usdc_placed ?? null}, ${fields.range_min ?? null},
              ${fields.range_max ?? null}, ${fields.range_pct ?? null},
              ${fields.usdc_remaining ?? null}, ${fields.token_id ?? null}, ${fields.error_msg ?? null},
              ${fields.usdc_on_close ?? null}, ${fields.pool_num ?? null},
              ${fields.weth ?? null}, ${fields.usdc ?? null}, ${fields.type ?? null})`;
  } catch (_) {}
}

async function sendErrorEmail(subject, body) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body:    JSON.stringify({
        from:    "onboarding@resend.dev",
        to:      "sylvain.fady@gmail.com",
        subject,
        html:    `<pre style="font-family:monospace">${body}</pre>`,
      }),
      signal: AbortSignal.timeout(10000),
    });
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
  process.env.ALCHEMY_RPC_URL,
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
].filter(Boolean);

const ERC20_IFACE = new ethers.Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

// "replacement fee too low" = tx pendante avec même nonce → retry avec gas +25%
async function sendTx(wallet, params) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await wallet.sendTransaction(params);
    } catch (e) {
      const msg = e.message ?? e.shortMessage ?? "";
      if (attempt < 2 && /replacement fee too low|replacement transaction underpriced/i.test(msg)) {
        const feeData = await wallet.provider.getFeeData();
        params = {
          ...params,
          maxFeePerGas:         (feeData.maxFeePerGas         ?? 2000000000n) * 125n / 100n,
          maxPriorityFeePerGas: (feeData.maxPriorityFeePerGas ?? 1000000n)   * 125n / 100n,
        };
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      throw e;
    }
  }
}

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
  const tx = await sendTx(wallet, {
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
  const { amountUSDC, minPrice, maxPrice, currentPrice, targetRatio, poolNum, caseNum } = await req.json();
  if (!amountUSDC || !minPrice || !maxPrice || !currentPrice)
    return Response.json({ error: "Paramètres manquants" }, { status: 400 });

  try {
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) return Response.json({ error: "PRIVATE_KEY manquant dans .env.local" }, { status: 500 });

    const rpcUrl   = await pickRpc();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    // Retry sur erreurs transitoires RPC (ex: "Temporary internal error. Please retry")
    const _rawSend = provider.send.bind(provider);
    provider.send = async function(method, params) {
      for (let i = 0; i < 3; i++) {
        try { return await _rawSend(method, params); } catch (e) {
          const msg = e?.message ?? String(e);
          if (i < 2 && (msg.includes("Temporary internal error") || msg.includes("Please retry")))
            { await new Promise(r => setTimeout(r, 1500 * (i + 1))); continue; }
          throw e;
        }
      }
    };
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
    const halfFrac = Math.sqrt(maxPrice / minPrice) - 1;
    let effectiveRatio = targetRatio ?? 0.5;
    let serverCenter   = findCenterForRatio(effectiveRatio, poolPrice, halfFrac);
    // Si le prix actuel tombe sous la borne basse du range → ratio inatteignable → fallback 50/50
    if (poolPrice < serverCenter / (1 + halfFrac)) {
      effectiveRatio = 0.5;
      serverCenter   = findCenterForRatio(0.5, poolPrice, halfFrac);
    }
    const serverMin = serverCenter / (1 + halfFrac);
    const serverMax = serverCenter * (1 + halfFrac);

    const rawLower   = priceToTick(serverMin);
    const rawUpper   = priceToTick(serverMax);
    const targetWidth = rawUpper - rawLower;
    const widthScale  = serverCenter / Math.max(1, targetWidth) / 10;
    // Largeur arrondie au multiple de tickSpacing le plus proche — contrainte prioritaire
    const roundedTargetWidth = Math.round(targetWidth / tickSpacing) * tickSpacing || tickSpacing;
    // Score : largeur contrainte en premier, puis ratio LP réel
    const pairScore = (lo, hi) => {
      if (Math.abs((hi - lo) - roundedTargetWidth) > tickSpacing / 2) return Infinity;
      const lp = tickToPrice(lo);
      const hp = tickToPrice(hi);
      const r  = optimalWethFraction(poolPrice, lp, hp);
      return Math.abs(r - effectiveRatio) * 1000 + Math.abs(hi - lo - targetWidth) * widthScale;
    };

    let tickLower = roundTickFloor(rawLower, tickSpacing);
    let tickUpper = roundTickCeil(rawUpper, tickSpacing);
    let bestScore = pairScore(tickLower, tickUpper);

    for (const [lo, hi] of [
      [roundTickCeil(rawLower,  tickSpacing), roundTickCeil(rawUpper,  tickSpacing)],
      [roundTickFloor(rawLower, tickSpacing), roundTickFloor(rawUpper, tickSpacing)],
      [roundTickCeil(rawLower,  tickSpacing), roundTickFloor(rawUpper, tickSpacing)],
    ]) {
      if (lo >= hi) continue;
      const s = pairScore(lo, hi);
      if (s < bestScore) { bestScore = s; tickLower = lo; tickUpper = hi; }
    }

    // Fallback si aucune paire ne respecte la contrainte de largeur
    if (bestScore === Infinity) {
      tickLower = roundTickFloor(rawLower, tickSpacing);
      tickUpper = roundTickCeil(rawUpper, tickSpacing);
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
      for (const url of RPC_URLS) {
        try {
          const res  = await fetch(url, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data: ERC20_IFACE.encodeFunctionData("balanceOf", [wallet.address]) }, "latest"] }),
            signal:  AbortSignal.timeout(6000),
          });
          const json = await res.json();
          if (json.result && json.result !== "0x")
            return ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], json.result)[0];
        } catch (_) {}
      }
      throw new Error(`balanceOf(${token}) échoué sur tous les RPCs`);
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
    // Utiliser les prix des ticks arrondis réels — garantit que le swap correspond exactement
    // à ce que le LP consomme, évitant tout reliquat WETH ou USDC après le mint.
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
      const swapCalldata = SWAP_ROUTER_IFACE.encodeFunctionData("exactInputSingle", [{
        tokenIn:            USDC,
        tokenOut:           WETH,
        tickSpacing,
        recipient:          wallet.address,
        deadline:           freshDeadline(),
        amountIn:           usdcToSwap,
        amountOutMinimum:   0n,
        sqrtPriceLimitX96:  0n,
      }]);
      let swapGas = 300000n;
      try { const est = await provider.estimateGas({ to: SWAP_ROUTER, from: wallet.address, data: swapCalldata }); swapGas = est * 3n / 2n; } catch (_) {}
      try {
        const txSwap = await sendTx(wallet, { to: SWAP_ROUTER, data: swapCalldata, gasLimit: swapGas });
        txSwapHash = txSwap.hash;
        await waitForTx(provider, txSwap);
        await new Promise(r => setTimeout(r, 4000));
      } catch (e) { throw new Error(`[étape 6 – swap USDC→WETH] ${e.shortMessage ?? e.message}`); }
    }

    // 7. Soldes réels après swap
    let wethBalance, usdcBalance;
    try {
      wethBalance = await readBal(WETH);
      usdcBalance = await readBal(USDC);
    } catch (e) { throw new Error(`[étape 7 – lecture soldes post-swap] ${e.shortMessage ?? e.message}`); }

    // Re-lire le prix du pool post-swap : l'impact de prix du swap déplace poolPrice,
    // ce qui change le ratio LP réel. Sans ça, le LP est contraint par le token sous-swappé.
    if (usdcToSwap > 0n) {
      try {
        const s0Post = await provider.call({ to: POOL, data: "0x3850c7bd" });
        const sqX    = ethers.AbiCoder.defaultAbiCoder().decode(["uint160"], s0Post)[0];
        const sqP2   = Number(sqX) / Number(2n ** 96n);
        const p2     = sqP2 * sqP2 * 1e12;
        if (p2 > 100 && p2 < 100000) poolPrice = p2;
      } catch (_) {}
    }

    // Recalculer le ratio LP avec le prix post-swap réel
    const swapRatioPost  = optimalWethFraction(poolPrice, tickLowerPrice, tickUpperPrice);
    let usdcBudgeted     = ethers.parseUnits(String((totalBudget * (1 - swapRatioPost)).toFixed(6)), 6);
    let wethBudgeted     = ethers.parseUnits(String((totalBudget * swapRatioPost / poolPrice).toFixed(18)), 18);
    let usdcToKeep       = usdcBalance < usdcBudgeted ? usdcBalance : usdcBudgeted;
    let wethToUse        = wethBalance < wethBudgeted ? wethBalance : wethBudgeted;

    // 7b. Swap correctif — comble l'écart résiduel dû au price impact du premier swap
    {
      const wethDeficit = wethBudgeted > wethBalance ? wethBudgeted - wethBalance : 0n;
      const usdcDeficit = usdcBudgeted > usdcBalance ? usdcBudgeted - usdcBalance : 0n;
      let didCorrect = false;

      if (wethDeficit > 0n) {
        // Pas assez de WETH → swap USDC→WETH pour le montant manquant
        const usdcNeeded = ethers.parseUnits(
          String(Math.min(
            Number(ethers.formatUnits(wethDeficit, 18)) * poolPrice,
            Number(ethers.formatUnits(usdcBalance, 6))
          ).toFixed(6)), 6
        );
        if (usdcNeeded > ethers.parseUnits("1", 6)) {
          try {
            await ensureAllowance(wallet, provider, USDC, SWAP_ROUTER, usdcNeeded);
            const cd2 = SWAP_ROUTER_IFACE.encodeFunctionData("exactInputSingle", [{
              tokenIn: USDC, tokenOut: WETH, tickSpacing,
              recipient: wallet.address, deadline: freshDeadline(),
              amountIn: usdcNeeded, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
            }]);
            let g2 = 300000n;
            try { const e2 = await provider.estimateGas({ to: SWAP_ROUTER, from: wallet.address, data: cd2 }); g2 = e2 * 3n / 2n; } catch (_) {}
            const tx2 = await sendTx(wallet, { to: SWAP_ROUTER, data: cd2, gasLimit: g2 });
            await waitForTx(provider, tx2);
            await new Promise(r => setTimeout(r, 2000));
            didCorrect = true;
          } catch (_) {}
        }
      } else if (usdcDeficit > ethers.parseUnits("1", 6)) {
        // Pas assez d'USDC → swap WETH→USDC pour le montant manquant
        const wethNeeded = ethers.parseUnits(
          String(Math.min(
            Number(ethers.formatUnits(usdcDeficit, 6)) / poolPrice,
            Number(ethers.formatUnits(wethBalance, 18))
          ).toFixed(18)), 18
        );
        if (wethNeeded > ethers.parseUnits("0.0003", 18)) {
          try {
            await ensureAllowance(wallet, provider, WETH, SWAP_ROUTER, wethNeeded);
            const cd2 = SWAP_ROUTER_IFACE.encodeFunctionData("exactInputSingle", [{
              tokenIn: WETH, tokenOut: USDC, tickSpacing,
              recipient: wallet.address, deadline: freshDeadline(),
              amountIn: wethNeeded, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
            }]);
            let g2 = 300000n;
            try { const e2 = await provider.estimateGas({ to: SWAP_ROUTER, from: wallet.address, data: cd2 }); g2 = e2 * 3n / 2n; } catch (_) {}
            const tx2 = await sendTx(wallet, { to: SWAP_ROUTER, data: cd2, gasLimit: g2 });
            await waitForTx(provider, tx2);
            await new Promise(r => setTimeout(r, 2000));
            didCorrect = true;
          } catch (_) {}
        }
      }

      if (didCorrect) {
        try { wethBalance = await readBal(WETH); usdcBalance = await readBal(USDC); } catch (_) {}
        try {
          const s0c = await provider.call({ to: POOL, data: "0x3850c7bd" });
          const sqc = ethers.AbiCoder.defaultAbiCoder().decode(["uint160"], s0c)[0];
          const pc  = Number(sqc) / Number(2n ** 96n);
          const pp  = pc * pc * 1e12;
          if (pp > 100 && pp < 100000) poolPrice = pp;
        } catch (_) {}
        const ratioFinal = optimalWethFraction(poolPrice, tickLowerPrice, tickUpperPrice);
        usdcBudgeted = ethers.parseUnits(String((totalBudget * (1 - ratioFinal)).toFixed(6)), 6);
        wethBudgeted = ethers.parseUnits(String((totalBudget * ratioFinal / poolPrice).toFixed(18)), 18);
        usdcToKeep   = usdcBalance < usdcBudgeted ? usdcBalance : usdcBudgeted;
        wethToUse    = wethBalance < wethBudgeted ? wethBalance : wethBudgeted;
      }
    }

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
    const mintDiag = `tickLower=${tickLower} tickUpper=${tickUpper} tickSpacing=${tickSpacing} amount0=${wethBalance} amount1=${usdcToKeep} swapRatio=${swapRatioPost.toFixed(4)} poolPrice=${poolPrice.toFixed(2)} usdcToSwap=${usdcToSwap} wethBefore=${wethBalBefore} wethDeficit=${wethDeficitUsdc.toFixed(2)}`;

    // Simulation avant envoi — non-bloquante : certains RPCs Base ne retournent pas les revert data
    let simWarning = null;
    try {
      await provider.call({ to: NFPM, from: wallet.address, data: NFPM_IFACE.encodeFunctionData("mint", [mintParams]) });
    } catch (simErr) {
      simWarning = `${simErr.shortMessage ?? simErr.message} | ${mintDiag}`;
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

      const mintTx = await sendTx(wallet, {
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
        const txSweep = await sendTx(wallet, {
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
      const txApproveId = await sendTx(wallet, {
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
        const txAll = await sendTx(wallet, {
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
      const txGauge = await sendTx(wallet, { to: gaugeAddr, data: depositData, gasLimit: gaugeGas });
      txGaugeHash = txGauge.hash;
      await waitForTx(provider, txGauge);
    } catch (e) { throw new Error(`[étape 12 – deposit gauge] tokenId=${tokenId} | ${e.message ?? e.shortMessage}`); }

    const budgetWarning = totalBudget < amountUSDC
      ? `⚠ Budget plafonné à $${totalBudget.toFixed(2)} (demandé $${amountUSDC}, disponible $${totalAvailable.toFixed(2)})`
      : null;

    const rangePct = ((tickUpperPrice / tickLowerPrice - 1) * 100).toFixed(2);

    const payload = {
      message:    `Position #${tokenId} créée — LP ${Math.round(swapRatio*100)}% WETH / ${Math.round((1-swapRatio)*100)}% USDC · range $${tickLowerPrice.toFixed(0)}→$${tickUpperPrice.toFixed(0)}`,
      tokenId:    tokenId.toString(),
      txSwap:     txSwapHash,
      txMint:     mintTxHash,
      txGauge:    txGaugeHash,
      rangePct:   parseFloat(rangePct),
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
      ...(simWarning     ? { simWarning }                : {}),
    };

    try {
      const usdcRestant = Number(ethers.formatUnits(await readBal(USDC), 6));
      const usdcPlaced  = usdcAvailable - usdcRestant;
      await logEvent({
        action1:        "CREATE_OK",
        usdc_placed:    usdcPlaced.toFixed(2),
        range_min:      tickLowerPrice,
        range_max:      tickUpperPrice,
        range_pct:      rangePct,
        usdc_remaining: usdcRestant.toFixed(2),
        token_id:       tokenId.toString(),
        pool_num:       poolNum ?? null,
        weth:           (Number(ethers.formatUnits(wethToUse, 18)) * poolPrice).toFixed(2),
        usdc:           Number(ethers.formatUnits(usdcToKeep, 6)).toFixed(2),
        type:           caseNum ?? null,
      });
    } catch (_) {}

    return Response.json(payload);

  } catch (e) {
    const msg = e.message ?? e.shortMessage ?? String(e);
    const rangePct = minPrice && maxPrice ? ((maxPrice / minPrice - 1) * 100).toFixed(2) : null;
    await logEvent({
      action1:   "CREATE_ERR",
      usdc_placed: amountUSDC ?? null,
      range_min: minPrice ?? null,
      range_max: maxPrice ?? null,
      range_pct: rangePct,
      error_msg: msg,
      pool_num:  poolNum ?? null,
      type:      caseNum ?? null,
    });
    await sendErrorEmail("[CryptoYieldTracker] Erreur — createPosition", `Cas : ${caseNum ?? "?"}\nErreur : ${msg}`);
    return Response.json({ error: msg }, { status: 500 });
  }
}
