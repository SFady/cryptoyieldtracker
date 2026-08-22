import { ethers } from "ethers";
import { neon }   from "@neondatabase/serverless";
import { writeCollectedToday, writeCollectErr, writeErrorState } from "../../lib/cronKv";
import { getPoolAddress } from "../../lib/config";

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

export const runtime     = "nodejs";
export const maxDuration = 300;

const sql = neon(process.env.DATABASE_URL);

const NFPM_OLD    = "0x827922686190790b37229fd06084350E74485b72";
const NFPM_NEW    = "0xe1f8cd9ac4e4a65f54f38a5cdafca44f6dd68b53";
const SWAP_ROUTER = "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5";
const V2_ROUTER   = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const V2_FACTORY  = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
const WETH        = "0x4200000000000000000000000000000000000006";
const AERO        = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const USDC        = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const VOTER       = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";

const RPC_URLS = [
  process.env.ALCHEMY_RPC_URL,
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
].filter(Boolean);

const MAX_UINT128 = (1n << 128n) - 1n;

const ERC20_IFACE = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

const NFPM_IFACE = new ethers.Interface([
  "function approve(address to, uint256 tokenId)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)",
  "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) returns (uint256 amount0, uint256 amount1)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
]);

const GAUGE_IFACE = new ethers.Interface([
  "function withdraw(uint256 tokenId)",
  "function getReward(uint256 tokenId)",
  "function deposit(uint256 tokenId)",
  "function deposit(uint256 tokenId, uint256 tokenVeloPair)",
  "function stakedContains(address depositor, uint256 tokenId) view returns (bool)",
]);

const VOTER_IFACE = new ethers.Interface([
  "function gauges(address pool) view returns (address)",
]);

const SWAP_ROUTER_IFACE = new ethers.Interface([
  "function exactInputSingle((address tokenIn, address tokenOut, int24 tickSpacing, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut)",
]);

const V2_ROUTER_IFACE = new ethers.Interface([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)",
  "function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)",
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

async function ethCall(to, data) {
  for (const url of RPC_URLS) {
    try {
      const res  = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
        signal: AbortSignal.timeout(6000),
      });
      const json = await res.json();
      if (json.result && json.result !== "0x") return json.result;
    } catch (_) {}
  }
  throw new Error(`eth_call(${to}) échoué sur tous les RPCs`);
}

async function readBal(token, address) {
  const h = await ethCall(token, ERC20_IFACE.encodeFunctionData("balanceOf", [address]));
  return ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], h)[0];
}

async function waitForTx(tx) {
  try {
    const r = await Promise.race([
      tx.wait(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("tx.wait() timeout")), 12000)),
    ]);
    if (r?.status === 0) throw new Error("reverted");
    return r;
  } catch (_) {
    for (let i = 0; i < 15; i++) {
      await new Promise(res => setTimeout(res, 2000));
      const url = RPC_URLS[i % RPC_URLS.length];
      try {
        const res  = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [tx.hash] }),
          signal: AbortSignal.timeout(3000),
        });
        const json = await res.json();
        if (json.result) {
          if (json.result.status === "0x0") throw new Error(`revert on-chain (hash=${tx.hash})`);
          return json.result;
        }
      } catch (e) {
        if (e.message?.startsWith("revert on-chain")) throw e;
      }
    }
    throw new Error(`timeout confirmation tx ${tx.hash}`);
  }
}

async function readTokenIdFromDb(poolNum) {
  let rows = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rows = await sql`
        SELECT token_id FROM lp_events
        WHERE action1 = 'CREATE_OK' AND action2 IS NULL
          AND COALESCE(pool_num, 2) = ${poolNum}
        ORDER BY id DESC LIMIT 1
      `;
      break;
    } catch (e) {
      if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue; }
      throw e;
    }
  }
  if (rows.length === 0 || !rows[0].token_id) return null;
  return rows[0].token_id;
}

// ─── ÉTAPE 1 : getReward + withdraw + decreaseLiquidity + collect ──────────────
async function handleStep1(poolNum) {
  let rawTokenId = null;
  try {
    const privateKey = poolNum === 3 ? process.env.PRIVATE_KEY_3 : process.env.PRIVATE_KEY;
    if (!privateKey) return Response.json({ error: `PRIVATE_KEY${poolNum === 3 ? "_3" : ""} manquant` }, { status: 500 });
    const NFPM = poolNum === 2 ? NFPM_NEW : NFPM_OLD;
    const POOL = getPoolAddress(poolNum);

    rawTokenId = await readTokenIdFromDb(poolNum);
    if (!rawTokenId) return Response.json({ skipped: true, reason: "Aucune position ouverte en DB" });
    const tokenId = BigInt(rawTokenId);

    const rpcUrl   = RPC_URLS[0]; // Alchemy en priorité — tx.wait() fiable ~4s
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet   = new ethers.Wallet(privateKey, provider);
    const freshDeadline = () => Math.floor(Date.now() / 1000) + 600;

    const gaugeHex = await ethCall(VOTER, VOTER_IFACE.encodeFunctionData("gauges", [POOL]));
    const [gaugeAddr] = VOTER_IFACE.decodeFunctionResult("gauges", gaugeHex);
    if (!gaugeAddr || gaugeAddr === ethers.ZeroAddress)
      return Response.json({ error: "Gauge introuvable" }, { status: 500 });

    let isStaked = false;
    try {
      const result = await ethCall(gaugeAddr, GAUGE_IFACE.encodeFunctionData("stakedContains", [wallet.address, tokenId]));
      const [staked] = GAUGE_IFACE.decodeFunctionResult("stakedContains", result);
      isStaked = staked;
    } catch (_) {}

    if (isStaked) {
      try {
        const tx = await wallet.sendTransaction({ to: gaugeAddr, data: GAUGE_IFACE.encodeFunctionData("getReward", [tokenId]) });
        await waitForTx(tx);
      } catch (_) {}
    }

    let withdrawOk = false;
    if (isStaked) {
      try {
        await provider.call({ to: gaugeAddr, data: GAUGE_IFACE.encodeFunctionData("withdraw", [tokenId]), from: wallet.address });
        console.log(`[step1 withdraw sim] OK — pas de revert simulé`);
      } catch (simErr) {
        console.log(`[step1 withdraw sim REVERT] ${simErr.message?.slice(0, 400) ?? simErr}`);
      }
      try {
        const tx = await wallet.sendTransaction({ to: gaugeAddr, data: GAUGE_IFACE.encodeFunctionData("withdraw", [tokenId]) });
        await waitForTx(tx);
        withdrawOk = true;
      } catch (e) {
        console.log(`[collectFees step1 withdraw failed] ${e.message ?? e}`);
      }
    }

    const usdcBefore = await readBal(USDC, wallet.address).catch(() => 0n);
    const wethBefore = await readBal(WETH, wallet.address).catch(() => 0n);

    let nftInWallet = withdrawOk;
    if (!nftInWallet) {
      try {
        const ownerHex = await ethCall(NFPM, NFPM_IFACE.encodeFunctionData("ownerOf", [tokenId]));
        const [owner] = NFPM_IFACE.decodeFunctionResult("ownerOf", ownerHex);
        nftInWallet = owner.toLowerCase() === wallet.address.toLowerCase();
      } catch (_) {}
    }

    if (nftInWallet) {
      try {
        const dlData = NFPM_IFACE.encodeFunctionData("decreaseLiquidity", [{
          tokenId, liquidity: 0n, amount0Min: 0n, amount1Min: 0n, deadline: freshDeadline(),
        }]);
        let dlGas = 300000n;
        try { const est = await provider.estimateGas({ to: NFPM, from: wallet.address, data: dlData }); dlGas = est * 3n / 2n; } catch (_) {}
        await waitForTx(await wallet.sendTransaction({ to: NFPM, data: dlData, gasLimit: dlGas }));
      } catch (e) { console.log(`[collectFees step1 decreaseLiquidity] ${e.message ?? e}`); }

      try {
        const collectData = NFPM_IFACE.encodeFunctionData("collect", [{
          tokenId, recipient: wallet.address, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128,
        }]);
        let collectGas = 300000n;
        try { const est = await provider.estimateGas({ to: NFPM, from: wallet.address, data: collectData }); collectGas = est * 3n / 2n; } catch (_) {}
        await waitForTx(await wallet.sendTransaction({ to: NFPM, data: collectData, gasLimit: collectGas }));
      } catch (e) { console.log(`[collectFees step1 collect] ${e.message ?? e}`); }
    }

    const wethAfter = await readBal(WETH, wallet.address).catch(() => 0n);
    const usdcAfter = await readBal(USDC, wallet.address).catch(() => 0n);
    console.log(`[collectFees step1] WETH: ${wethBefore}→${wethAfter} delta=${wethAfter > wethBefore ? wethAfter - wethBefore : 0n}, USDC: ${usdcBefore}→${usdcAfter} delta=${usdcAfter > usdcBefore ? usdcAfter - usdcBefore : 0n}, nftInWallet=${nftInWallet}, isStaked=${isStaked}`);

    return Response.json({
      ok: true,
      rawTokenId,
      isStaked,
      nftInWallet,
      wethBefore:  wethBefore.toString(),
      usdcBefore:  usdcBefore.toString(),
    });
  } catch (e) {
    const msg = e.message ?? String(e);
    await sendErrorEmail("[CryptoYieldTracker] Erreur step1 — collectFees", `Pool : ${poolNum}\nTokenId : ${rawTokenId}\n\nErreur : ${msg}`);
    return Response.json({ error: msg }, { status: 500 });
  }
}

// ─── ÉTAPE 2 : swap WETH → USDC + swap AERO → USDC ──────────────────────────
async function handleStep2(poolNum, body) {
  try {
    const privateKey = poolNum === 3 ? process.env.PRIVATE_KEY_3 : process.env.PRIVATE_KEY;
    if (!privateKey) return Response.json({ error: "PRIVATE_KEY manquant" }, { status: 500 });
    const POOL = getPoolAddress(poolNum);

    const wethBefore = BigInt(body.wethBefore ?? "0");

    const rpcUrl   = RPC_URLS[0]; // Alchemy en priorité — tx.wait() fiable ~4s
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet   = new ethers.Wallet(privateKey, provider);
    const freshDeadline = () => Math.floor(Date.now() / 1000) + 600;

    let swapWethHash = null;
    let swapWethError = null;
    try {
      const wethAfter = await readBal(WETH, wallet.address).catch(() => 0n);
      const wethFees  = wethAfter > wethBefore ? wethAfter - wethBefore : 0n;
      if (wethFees > 0n) {
        let tickSpacing = 100;
        try {
          const tsRaw = await ethCall(POOL, "0xd0c93a7c");
          const ts = Number(ethers.toBigInt(tsRaw));
          if (ts > 0) tickSpacing = ts;
        } catch (_) {}

        try {
          const h = await ethCall(WETH, ERC20_IFACE.encodeFunctionData("allowance", [wallet.address, SWAP_ROUTER]));
          const [current] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], h);
          if (current < wethFees) {
            await waitForTx(await wallet.sendTransaction({ to: WETH, data: ERC20_IFACE.encodeFunctionData("approve", [SWAP_ROUTER, ethers.MaxUint256]) }));
          }
        } catch (_) {}

        let wethPriceInUsdc6 = 0n;
        try {
          const s0Hex = await ethCall(POOL, "0x3850c7bd");
          const hex = s0Hex.startsWith("0x") ? s0Hex.slice(2) : s0Hex;
          const sqrtPriceX96 = BigInt("0x" + hex.slice(0, 64));
          const sqrtPf = Number(sqrtPriceX96) / 2**96;
          wethPriceInUsdc6 = BigInt(Math.round(sqrtPf * sqrtPf * 1e18));
        } catch (_) {}

        let swapGas = 300000n;
        let swapOk = false;
        for (const pct of [990n, 980n, 970n, 0n]) {
          try {
            const minOut = (wethPriceInUsdc6 > 0n && pct > 0n) ? wethFees * wethPriceInUsdc6 / (10n ** 18n) * pct / 1000n : 0n;
            const swapData = SWAP_ROUTER_IFACE.encodeFunctionData("exactInputSingle", [{
              tokenIn: WETH, tokenOut: USDC, tickSpacing,
              recipient: wallet.address, deadline: freshDeadline(),
              amountIn: wethFees, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
            }]);
            try { swapGas = (await provider.estimateGas({ to: SWAP_ROUTER, from: wallet.address, data: swapData })) * 3n / 2n; }
            catch (_) { if (pct > 0n) continue; }
            const txSwap = await wallet.sendTransaction({ to: SWAP_ROUTER, data: swapData, gasLimit: swapGas });
            swapWethHash = txSwap.hash;
            await waitForTx(txSwap);
            swapOk = true;
            break;
          } catch (e) { swapWethError = e.message ?? String(e); }
        }
        if (!swapOk) console.log(`[collectFees step2 swapWeth] échec — ${swapWethError}`);
      }
    } catch (e) { swapWethError = e.message ?? String(e); }

    let aeroSwapHash = null;
    try {
      const aeroBal  = await readBal(AERO, wallet.address);
      const MIN_AERO = ethers.parseUnits("0.01", 18);
      if (aeroBal >= MIN_AERO) {
        await waitForTx(await wallet.sendTransaction({
          to: AERO, data: ERC20_IFACE.encodeFunctionData("approve", [V2_ROUTER, ethers.MaxUint256]),
        }));
        const routes = [{ from: AERO, to: USDC, stable: false, factory: V2_FACTORY }];
        let expectedUsdcOut = 0n;
        try {
          const outHex = await ethCall(V2_ROUTER, V2_ROUTER_IFACE.encodeFunctionData("getAmountsOut", [aeroBal, routes]));
          const [amounts] = V2_ROUTER_IFACE.decodeFunctionResult("getAmountsOut", outHex);
          expectedUsdcOut = amounts[amounts.length - 1];
        } catch (_) {}
        let aeroSwapGas = 300000n;
        for (const pct of [990n, 980n, 970n, 0n]) {
          try {
            const minOut = pct > 0n ? expectedUsdcOut * pct / 1000n : 0n;
            const swapData = V2_ROUTER_IFACE.encodeFunctionData("swapExactTokensForTokens", [
              aeroBal, minOut, routes, wallet.address, freshDeadline(),
            ]);
            try { const est = await provider.estimateGas({ to: V2_ROUTER, from: wallet.address, data: swapData }); aeroSwapGas = est * 3n / 2n; }
            catch (_) { if (pct > 0n) continue; }
            const txSwap = await wallet.sendTransaction({ to: V2_ROUTER, data: swapData, gasLimit: aeroSwapGas });
            aeroSwapHash = txSwap.hash;
            await waitForTx(txSwap);
            break;
          } catch (_) {}
        }
      }
    } catch (_) {}

    return Response.json({ ok: true, swapWethHash, aeroSwapHash, ...(swapWethError ? { swapWethError } : {}) });
  } catch (e) {
    return Response.json({ error: e.message ?? String(e) }, { status: 500 });
  }
}

// ─── ÉTAPE 3 : transfer + log DB + restake ───────────────────────────────────
async function handleStep3(poolNum, noTransfer, caseNum, body) {
  let rawTokenId = body.rawTokenId ?? null;
  try {
    const privateKey = poolNum === 3 ? process.env.PRIVATE_KEY_3 : process.env.PRIVATE_KEY;
    if (!privateKey) return Response.json({ error: "PRIVATE_KEY manquant" }, { status: 500 });
    const NFPM = poolNum === 2 ? NFPM_NEW : NFPM_OLD;
    const POOL = getPoolAddress(poolNum);

    if (!rawTokenId) {
      rawTokenId = await readTokenIdFromDb(poolNum);
      if (!rawTokenId) return Response.json({ skipped: true, reason: "Aucune position ouverte en DB" });
    }
    const tokenId = BigInt(rawTokenId);

    const isStaked   = body.isStaked   ?? false;
    const usdcBefore = BigInt(body.usdcBefore ?? "0");

    const gaugeHex = await ethCall(VOTER, VOTER_IFACE.encodeFunctionData("gauges", [POOL]));
    const [gaugeAddr] = VOTER_IFACE.decodeFunctionResult("gauges", gaugeHex);

    const rpcUrl   = RPC_URLS[0]; // Alchemy en priorité — tx.wait() fiable ~4s
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet   = new ethers.Wallet(privateKey, provider);
    const freshDeadline = () => Math.floor(Date.now() / 1000) + 600;

    let transferHash = null;
    try {
      const dest = poolNum === 3 ? process.env.DESTINATION_WALLET_3 : process.env.DESTINATION_WALLET;
      if (dest && !noTransfer) {
        const usdcAfter = await readBal(USDC, wallet.address).catch(() => 0n);
        const delta     = usdcAfter > usdcBefore ? usdcAfter - usdcBefore : 0n;
        const toSend    = delta / 2n;
        if (toSend > 0n) {
          const txTransfer = await wallet.sendTransaction({
            to: USDC, data: ERC20_IFACE.encodeFunctionData("transfer", [dest, toSend]),
          });
          transferHash = txTransfer.hash;
          await waitForTx(txTransfer);
          try {
            const amt = parseFloat(ethers.formatUnits(toSend, 6));
            await sql`INSERT INTO dest_transfers (amount_usdc, source, tx_hash, pool_num) VALUES (${amt}, ${`cas${caseNum}`}, ${transferHash}, ${poolNum})`;
          } catch (_) {}
        }
      }
    } catch (e) { console.log(`[collectFees step3 transfer] ${e.message ?? e}`); }

    try {
      await sql`INSERT INTO lp_events (action1, token_id, pool_num) VALUES ('FEE_COLLECT', ${rawTokenId}, ${poolNum})`;
      await writeCollectedToday(poolNum);
      await writeCollectErr(poolNum, false);
    } catch (_) {}

    let restakeError = null;
    let nftInWallet = false;
    try {
      const ownerHex = await ethCall(NFPM, NFPM_IFACE.encodeFunctionData("ownerOf", [tokenId]));
      const [owner] = NFPM_IFACE.decodeFunctionResult("ownerOf", ownerHex);
      nftInWallet = owner.toLowerCase() === wallet.address.toLowerCase();
    } catch (_) {}

    if (isStaked && nftInWallet) {
      let restakeOk = false;
      let nonce;
      try { nonce = await provider.getTransactionCount(wallet.address, "pending"); } catch (_) {}
      const withNonce = (n) => (nonce !== undefined ? { nonce: n } : {});

      try {
        await waitForTx(await wallet.sendTransaction({
          to: NFPM, data: NFPM_IFACE.encodeFunctionData("approve", [gaugeAddr, tokenId]), ...withNonce(nonce++),
        }));
      } catch (_) {
        try { nonce = await provider.getTransactionCount(wallet.address, "pending"); } catch (_) {}
      }

      if (!restakeOk) try {
        const depositData = GAUGE_IFACE.encodeFunctionData("deposit(uint256,uint256)", [tokenId, 0n]);
        let gas = 500000n;
        try { gas = (await provider.estimateGas({ to: gaugeAddr, from: wallet.address, data: depositData })) * 3n / 2n; }
        catch (_) { throw new Error("estimateGas deposit A échoué"); }
        await waitForTx(await wallet.sendTransaction({ to: gaugeAddr, data: depositData, gasLimit: gas, ...withNonce(nonce++) }));
        restakeOk = true;
      } catch (_) {
        try { nonce = await provider.getTransactionCount(wallet.address, "pending"); } catch (_) {}
      }

      if (!restakeOk) try {
        const depositData = GAUGE_IFACE.encodeFunctionData("deposit(uint256)", [tokenId]);
        let gas = 500000n;
        try { gas = (await provider.estimateGas({ to: gaugeAddr, from: wallet.address, data: depositData })) * 3n / 2n; }
        catch (_) { throw new Error("estimateGas deposit B échoué"); }
        await waitForTx(await wallet.sendTransaction({ to: gaugeAddr, data: depositData, gasLimit: gas, ...withNonce(nonce++) }));
        restakeOk = true;
      } catch (_) {
        try { nonce = await provider.getTransactionCount(wallet.address, "pending"); } catch (_) {}
      }

      if (!restakeOk) try {
        const stfData = NFPM_IFACE.encodeFunctionData("safeTransferFrom", [wallet.address, gaugeAddr, tokenId]);
        let gas = 500000n;
        try { gas = (await provider.estimateGas({ to: NFPM, from: wallet.address, data: stfData })) * 3n / 2n; } catch (_) {}
        await waitForTx(await wallet.sendTransaction({ to: NFPM, data: stfData, gasLimit: gas, ...withNonce(nonce++) }));
        restakeOk = true;
      } catch (e) {
        restakeError = `3 méthodes échouées — ${e.message ?? String(e)}`;
      }

      if (!restakeOk && !restakeError) restakeError = "Toutes les méthodes de restake ont échoué";
      if (restakeError) {
        console.log(`[collectFees step3 restake] ${restakeError}`);
        await writeErrorState(poolNum, true, `Restake échoué — NFT #${rawTokenId} dans wallet non staké. Relancer via cas 7. Erreur : ${restakeError}`);
        await sendErrorEmail("[CryptoYieldTracker] Erreur — Restake collectFees", `Pool : ${poolNum}\nTokenId : ${rawTokenId}\n\nErreur : ${restakeError}\n\nRelancer avec : autoRebalance?case=7&poolNum=${poolNum}`);
      }
    }

    return Response.json({ ok: true, transferHash, ...(restakeError ? { restakeError } : {}) });
  } catch (e) {
    const msg = e.message ?? String(e);
    const isInfra = !rawTokenId || msg.includes("Control plane request failed") || msg.includes("neon:retryable");
    if (!isInfra) {
      try {
        await sql`INSERT INTO lp_events (action1, action2, error_msg, token_id, pool_num) VALUES ('FEE_COLLECT', 'COLLECT_ERR', ${msg}, ${rawTokenId}, ${poolNum})`;
        await writeCollectErr(poolNum, true);
      } catch (_) {}
    }
    await sendErrorEmail("[CryptoYieldTracker] Erreur step3 — collectFees", `Pool : ${poolNum}\nTokenId : ${rawTokenId}\n\nErreur : ${msg}`);
    return Response.json({ error: msg }, { status: 500 });
  }
}

// ─── Handler principal ────────────────────────────────────────────────────────
export async function POST(req) {
  const body       = await req.json().catch(() => ({}));
  const poolNum    = body.poolNum    ?? 2;
  const caseNum    = body.caseNum    ?? 5;
  const noTransfer = body.noTransfer ?? false;
  const step       = body.step       ?? 1;

  if (step === 1) return handleStep1(poolNum);
  if (step === 2) return handleStep2(poolNum, body);
  if (step === 3) return handleStep3(poolNum, noTransfer, caseNum, body);
  return Response.json({ error: `step invalide: ${step}` }, { status: 400 });
}
