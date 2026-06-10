import { ethers } from "ethers";
import { neon }   from "@neondatabase/serverless";
import { writeCollectedToday, writeCollectErr } from "../../lib/cronKv";
import { POOL_ADDRESS as POOL } from "../../lib/config";

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
export const maxDuration = 180;

const sql = neon(process.env.DATABASE_URL);

const NFPM        = "0x827922686190790b37229fd06084350E74485b72";
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
]);

const GAUGE_IFACE = new ethers.Interface([
  "function withdraw(uint256 tokenId)",
  "function getReward(uint256 tokenId)",
  "function deposit(uint256 tokenId)",
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
    const r = await tx.wait();
    if (r?.status === 0) throw new Error("reverted");
    return r;
  } catch (_) {
    for (let i = 0; i < 30; i++) {
      await new Promise(res => setTimeout(res, 2000));
      for (const url of RPC_URLS) {
        try {
          const res  = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [tx.hash] }),
            signal: AbortSignal.timeout(6000),
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
    }
    throw new Error(`timeout confirmation tx ${tx.hash}`);
  }
}

export async function POST(req) {
  const body    = await req.json().catch(() => ({}));
  const poolNum = body.poolNum ?? 2;
  const caseNum = body.caseNum ?? 5;
  let rawTokenId = null;

  try {
    const privateKey = poolNum === 3 ? process.env.PRIVATE_KEY_3 : process.env.PRIVATE_KEY;
    if (!privateKey) return Response.json({ error: `PRIVATE_KEY${poolNum === 3 ? "_3" : ""} manquant` }, { status: 500 });

    // 1. Récupérer le tokenId depuis la DB
    const rows = await sql`
      SELECT token_id FROM lp_events
      WHERE action1 = 'CREATE_OK' AND action2 IS NULL
        AND COALESCE(pool_num, 2) = ${poolNum}
      ORDER BY id DESC LIMIT 1
    `;
    if (rows.length === 0 || !rows[0].token_id)
      return Response.json({ skipped: true, reason: "Aucune position ouverte en DB" });
    rawTokenId = rows[0].token_id;
    const tokenId = BigInt(rawTokenId);

    const rpcUrl  = await pickRpc();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet   = new ethers.Wallet(privateKey, provider);
    const freshDeadline = () => Math.floor(Date.now() / 1000) + 600;

    // 2. Gauge address
    const gaugeHex = await ethCall(VOTER, VOTER_IFACE.encodeFunctionData("gauges", [POOL]));
    const [gaugeAddr] = VOTER_IFACE.decodeFunctionResult("gauges", gaugeHex);
    if (!gaugeAddr || gaugeAddr === ethers.ZeroAddress)
      return Response.json({ error: "Gauge introuvable" }, { status: 500 });

    // 3. Vérifier si le NFT est staké via stakedContains — ownerOf peut retourner le gauge
    //    sans déposant valide (NFT bloqué), ce qui ferait échouer withdraw avec "NA"
    let isStaked = false;
    try {
      const result = await ethCall(gaugeAddr, GAUGE_IFACE.encodeFunctionData("stakedContains", [wallet.address, tokenId]));
      const [staked] = GAUGE_IFACE.decodeFunctionResult("stakedContains", result);
      isStaked = staked;
    } catch (_) {}

    // 4. Claim AERO rewards (non-bloquant)
    if (isStaked) {
      try {
        const tx = await wallet.sendTransaction({
          to: gaugeAddr,
          data: GAUGE_IFACE.encodeFunctionData("getReward", [tokenId]),
        });
        await waitForTx(tx);
      } catch (_) {}
    }

    // 5. Unstake (withdraw) — non-bloquant : si revert, on skip collect LP mais on traite l'AERO du wallet
    let withdrawOk = false;
    if (isStaked) {
      try {
        const tx = await wallet.sendTransaction({
          to: gaugeAddr,
          data: GAUGE_IFACE.encodeFunctionData("withdraw", [tokenId]),
        });
        await waitForTx(tx);
        withdrawOk = true;
      } catch (e) {
        console.log(`[collectFees withdraw failed — continuing with AERO only] ${e.message ?? e}`);
      }
    }

    // 6. Collect fees WETH + USDC — uniquement si withdraw OK (NFT dans le wallet)
    const usdcBefore = await readBal(USDC, wallet.address).catch(() => 0n);
    const wethBefore = await readBal(WETH, wallet.address).catch(() => 0n);
    if (withdrawOk) {
      try {
        const collectData = NFPM_IFACE.encodeFunctionData("collect", [{
          tokenId,
          recipient:   wallet.address,
          amount0Max:  MAX_UINT128,
          amount1Max:  MAX_UINT128,
        }]);
        let collectGas = 300000n;
        try { const est = await provider.estimateGas({ to: NFPM, from: wallet.address, data: collectData }); collectGas = est * 3n / 2n; } catch (_) {}
        const tx = await wallet.sendTransaction({ to: NFPM, data: collectData, gasLimit: collectGas });
        await waitForTx(tx);
      } catch (e) { throw new Error(`[collect] ${e.message ?? e}`); }
    }

    // 6. Swap fees WETH → USDC
    let swapWethHash = null;
    try {
      const wethAfter = await readBal(WETH, wallet.address).catch(() => 0n);
      const wethFees  = wethAfter > wethBefore ? wethAfter - wethBefore : 0n;
      if (wethFees > 0n) {
        const tsRaw      = await ethCall(POOL, "0xd0c93a7c");
        const tickSpacing = Number(ethers.toBigInt(tsRaw));
        try {
          const h = await ethCall(WETH, ERC20_IFACE.encodeFunctionData("allowance", [wallet.address, SWAP_ROUTER]));
          const [current] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], h);
          if (current < wethFees) {
            const txApp = await wallet.sendTransaction({ to: WETH, data: ERC20_IFACE.encodeFunctionData("approve", [SWAP_ROUTER, ethers.MaxUint256]) });
            await waitForTx(txApp);
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
        for (const pct of [990n, 980n, 970n]) {
          try {
            const minOut = wethPriceInUsdc6 > 0n ? wethFees * wethPriceInUsdc6 / (10n ** 18n) * pct / 1000n : 0n;
            const swapData = SWAP_ROUTER_IFACE.encodeFunctionData("exactInputSingle", [{
              tokenIn: WETH, tokenOut: USDC, tickSpacing,
              recipient: wallet.address, deadline: freshDeadline(),
              amountIn: wethFees, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
            }]);
            try { const est = await provider.estimateGas({ to: SWAP_ROUTER, from: wallet.address, data: swapData }); swapGas = est * 3n / 2n; } catch (_) {}
            const txSwap = await wallet.sendTransaction({ to: SWAP_ROUTER, data: swapData, gasLimit: swapGas });
            swapWethHash = txSwap.hash;
            await waitForTx(txSwap);
            break;
          } catch (_) {}
        }
      }
    } catch (e) { console.log(`[collectFees swapWeth] ${e.message ?? e}`); }

    // 8. Swap AERO → USDC
    let aeroSwapHash = null;
    try {
      const aeroBal  = await readBal(AERO, wallet.address);
      const MIN_AERO = ethers.parseUnits("0.01", 18);
      if (aeroBal >= MIN_AERO) {
        const txApp = await wallet.sendTransaction({
          to:   AERO,
          data: ERC20_IFACE.encodeFunctionData("approve", [V2_ROUTER, ethers.MaxUint256]),
        });
        await waitForTx(txApp);
        const routes = [{ from: AERO, to: USDC, stable: false, factory: V2_FACTORY }];
        let expectedUsdcOut = 0n;
        try {
          const outHex = await ethCall(V2_ROUTER, V2_ROUTER_IFACE.encodeFunctionData("getAmountsOut", [aeroBal, routes]));
          const [amounts] = V2_ROUTER_IFACE.decodeFunctionResult("getAmountsOut", outHex);
          expectedUsdcOut = amounts[amounts.length - 1];
        } catch (_) {}
        let aeroSwapGas = 300000n;
        for (const pct of [990n, 980n, 970n]) {
          try {
            const minOut = expectedUsdcOut * pct / 1000n;
            const swapData = V2_ROUTER_IFACE.encodeFunctionData("swapExactTokensForTokens", [
              aeroBal, minOut, routes, wallet.address, freshDeadline(),
            ]);
            try { const est = await provider.estimateGas({ to: V2_ROUTER, from: wallet.address, data: swapData }); aeroSwapGas = est * 3n / 2n; } catch (_) {}
            const txSwap = await wallet.sendTransaction({ to: V2_ROUTER, data: swapData, gasLimit: aeroSwapGas });
            aeroSwapHash = txSwap.hash;
            await waitForTx(txSwap);
            break;
          } catch (_) {}
        }
      }
    } catch (_) {}

    // 9. Envoyer 75% du delta USDC — pool 2 : ETH natif → wallet pool 3 / pool 3 : USDC → DESTINATION_WALLET_3
    let transferHash = null;
    try {
      const usdcAfter = await readBal(USDC, wallet.address).catch(() => 0n);
      const delta     = usdcAfter > usdcBefore ? usdcAfter - usdcBefore : 0n;
      const toSend    = delta * 75n / 100n;
      console.log(`[collectFees] before=${usdcBefore} after=${usdcAfter} delta=${delta} toSend=${toSend}`);
      if (toSend > 0n) {
        if (poolNum === 2) {
          // Pool 2 : USDC → WETH → ETH natif → wallet pool 3
          const pool3Addr = process.env.WALLET_ADDRESS_3;
          if (pool3Addr) {
            const tsRaw = await ethCall(POOL, "0xd0c93a7c");
            const tickSpacing = Number(ethers.toBigInt(tsRaw));
            let wethPriceBig = 1700n;
            try {
              const s0Hex = await ethCall(POOL, "0x3850c7bd");
              const hex = s0Hex.startsWith("0x") ? s0Hex.slice(2) : s0Hex;
              const sqrtPriceX96 = BigInt("0x" + hex.slice(0, 64));
              const sqrtPf = Number(sqrtPriceX96) / 2**96;
              wethPriceBig = BigInt(Math.round(sqrtPf * sqrtPf * 1e12));
            } catch (_) {}
            try {
              const h = await ethCall(USDC, ERC20_IFACE.encodeFunctionData("allowance", [wallet.address, SWAP_ROUTER]));
              const [cur] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], h);
              if (cur < toSend) {
                const txApp = await wallet.sendTransaction({ to: USDC, data: ERC20_IFACE.encodeFunctionData("approve", [SWAP_ROUTER, ethers.MaxUint256]) });
                await waitForTx(txApp);
              }
            } catch (_) {}
            const wethBal0 = await readBal(WETH, wallet.address).catch(() => 0n);
            let swapDone = false;
            for (const pct of [990n, 980n, 970n]) {
              try {
                const minWeth = wethPriceBig > 0n ? toSend * pct * 10n**12n / (1000n * wethPriceBig) : 0n;
                const swapData = SWAP_ROUTER_IFACE.encodeFunctionData("exactInputSingle", [{
                  tokenIn: USDC, tokenOut: WETH, tickSpacing,
                  recipient: wallet.address, deadline: freshDeadline(),
                  amountIn: toSend, amountOutMinimum: minWeth, sqrtPriceLimitX96: 0n,
                }]);
                let swapGas = 300000n;
                try { const est = await provider.estimateGas({ to: SWAP_ROUTER, from: wallet.address, data: swapData }); swapGas = est * 3n / 2n; } catch (_) {}
                const txSwap = await wallet.sendTransaction({ to: SWAP_ROUTER, data: swapData, gasLimit: swapGas });
                await waitForTx(txSwap);
                swapDone = true;
                break;
              } catch (_) {}
            }
            if (swapDone) {
              const wethBal1 = await readBal(WETH, wallet.address).catch(() => 0n);
              const wethReceived = wethBal1 > wethBal0 ? wethBal1 - wethBal0 : 0n;
              if (wethReceived > 0n) {
                const withdrawData = "0x2e1a7d4d" + wethReceived.toString(16).padStart(64, "0");
                let wGas = 60000n;
                try { const est = await provider.estimateGas({ to: WETH, from: wallet.address, data: withdrawData }); wGas = est * 3n / 2n; } catch (_) {}
                const txW = await wallet.sendTransaction({ to: WETH, data: withdrawData, gasLimit: wGas });
                await waitForTx(txW);
                let ethGas = 25000n;
                try { ethGas = await provider.estimateGas({ to: pool3Addr, value: wethReceived }); ethGas = ethGas * 3n / 2n; } catch (_) {}
                const txEth = await wallet.sendTransaction({ to: pool3Addr, value: wethReceived, gasLimit: ethGas });
                transferHash = txEth.hash;
                await waitForTx(txEth);
                try {
                  const amt = parseFloat(ethers.formatUnits(toSend, 6));
                  await sql`INSERT INTO dest_transfers (amount_usdc, source, tx_hash, pool_num) VALUES (${amt}, ${`cas${caseNum}-eth`}, ${transferHash}, ${poolNum})`;
                } catch (_) {}
              }
            }
          }
        } else {
          // Pool 3 : transfert USDC direct (inchangé)
          const dest = process.env.DESTINATION_WALLET_3;
          if (dest) {
            const txTransfer = await wallet.sendTransaction({
              to:   USDC,
              data: ERC20_IFACE.encodeFunctionData("transfer", [dest, toSend]),
            });
            transferHash = txTransfer.hash;
            await waitForTx(txTransfer);
            try {
              const amt = parseFloat(ethers.formatUnits(toSend, 6));
              await sql`INSERT INTO dest_transfers (amount_usdc, source, tx_hash, pool_num) VALUES (${amt}, ${`cas${caseNum}`}, ${transferHash}, ${poolNum})`;
            } catch (_) {}
          }
        }
      }
    } catch (e) { console.log(`[collectFees transfer] ${e.message ?? e}`); }

    // 10. Logger FEE_COLLECT en DB + marquer dans Redis (pas de modification action2 — position reste ouverte)
    try {
      await sql`INSERT INTO lp_events (action1, token_id, pool_num) VALUES ('FEE_COLLECT', ${rawTokenId}, ${poolNum})`;
      await writeCollectedToday(poolNum);
      await writeCollectErr(poolNum, false);
    } catch (_) {}

    // 11. Re-stake via approve + gauge.deposit — uniquement si withdraw a réussi
    let restakeError = null;
    if (isStaked && withdrawOk) {
      try {
        // Approuver le gauge pour ce tokenId
        const txApprove = await wallet.sendTransaction({
          to:   NFPM,
          data: NFPM_IFACE.encodeFunctionData("approve", [gaugeAddr, tokenId]),
        });
        await waitForTx(txApprove);
        // Déposer dans le gauge — enregistre wallet comme déposant légitime
        let depositGas = 300000n;
        try { const est = await provider.estimateGas({ to: gaugeAddr, from: wallet.address, data: GAUGE_IFACE.encodeFunctionData("deposit", [tokenId]) }); depositGas = est * 3n / 2n; } catch (_) {}
        const txStake = await wallet.sendTransaction({
          to:       gaugeAddr,
          data:     GAUGE_IFACE.encodeFunctionData("deposit", [tokenId]),
          gasLimit: depositGas,
        });
        await waitForTx(txStake);
      } catch (e) {
        restakeError = e.message ?? String(e);
        console.log(`[collectFees restake] ${restakeError}`);
        await sendErrorEmail("[CryptoYieldTracker] Erreur — Restake collectFees", `Pool : ${poolNum}\nTokenId : ${rawTokenId}\n\nErreur : ${restakeError}`);
      }
    }

    return Response.json({ ok: true, swapWethHash, aeroSwapHash, transferHash, ...(restakeError ? { restakeError } : {}) });

  } catch (e) {
    const msg = e.message ?? String(e);
    try {
      await sql`INSERT INTO lp_events (action1, action2, error_msg, token_id, pool_num) VALUES ('FEE_COLLECT', 'COLLECT_ERR', ${msg}, ${rawTokenId}, ${poolNum})`;
      await writeCollectErr(poolNum, true);
    } catch (_) {}
    await sendErrorEmail("[CryptoYieldTracker] Erreur — collectFees", `Pool : ${poolNum}\nTokenId : ${rawTokenId}\n\nErreur : ${msg}`);
    return Response.json({ error: msg }, { status: 500 });
  }
}
