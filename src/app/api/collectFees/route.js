import { ethers } from "ethers";
import { neon }   from "@neondatabase/serverless";
import { writeCollectedToday, writeCollectErr, writeErrorState } from "../../lib/cronKv";
import { getPoolAddress, GAUGE_ADDRESS_2 } from "../../lib/config";
import { isAuthorized, unauthorizedResponse } from "../../lib/apiAuth";

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

const WETH        = "0x4200000000000000000000000000000000000006";
const AERO        = "0x3f5bf3edac59d650d8fdf9657a71f2f904a3a4ee"; // nouveau AERO (protocole fusionné, 21/10) — lecture solde uniquement, plus swappé
const USDC        = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

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
  // Nouveau gauge (23/10) — remplace getReward, voir CLGauge.claimEmissions(address,address).
  "function claimEmissions(address account, address recipient)",
  "function deposit(uint256 tokenId)",
  "function deposit(uint256 tokenId, uint256 tokenVeloPair)",
  "function stakedContains(address depositor, uint256 tokenId) view returns (bool)",
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

// Nonce suivi en mémoire sur l'instance wallet (une par requête), pour toute la durée de
// l'exécution — jamais rerequêté au RPC entre deux envois séquentiels différents (évite une course
// de propagation entre deux appels, cf. incidents nonce du 02-04/10 dans closePositions/
// createPosition). Avant ce fix, ce fichier appelait wallet.sendTransaction() directement, sans
// aucun retry ni gestion de nonce — d'où le "replacement transaction underpriced" sur l'approve
// AERO (06/10) : deux envois concurrents avec le même nonce "pending" stale, le second pas assez
// cher pour remplacer le premier.
async function sendTx(wallet, params) {
  if (wallet._nextNonce == null) {
    wallet._nextNonce = await wallet.provider.getTransactionCount(wallet.address, "pending");
  }
  let nonce = params.nonce ?? wallet._nextNonce;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const tx = await wallet.sendTransaction({ ...params, nonce });
      wallet._nextNonce = nonce + 1;
      return tx;
    } catch (e) {
      const msg = ((e.shortMessage ?? "") + " " + (e.message ?? "")).toLowerCase();
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
      if (attempt < 2 && /nonce too low|nonce has already been used|nonce already|transaction already imported/i.test(msg)) {
        nonce = await wallet.provider.getTransactionCount(wallet.address, "pending");
        wallet._nextNonce = nonce;
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      if (attempt < 2 && /server response [45]\d\d|network error|econnreset|etimedout|socket hang|429|rate limit|compute units/i.test(msg)) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      throw e;
    }
  }
}

const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
function parseUsdcReceived(receipt, walletAddress) {
  if (!receipt?.logs) return 0n;
  const walletTopic = ethers.zeroPadValue(walletAddress, 32).toLowerCase();
  let total = 0n;
  for (const log of receipt.logs) {
    if (!log?.address || log.address.toLowerCase() !== USDC.toLowerCase()) continue;
    if (!log.topics || log.topics[0] !== TRANSFER_TOPIC) continue;
    if (!log.topics[2] || log.topics[2].toLowerCase() !== walletTopic) continue;
    try { total += BigInt(log.data); } catch (_) {}
  }
  return total;
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

// ─── ÉTAPE 1 : getReward (AERO + part LP des fees via gauge) ─────────────────
async function handleStep1(poolNum) {
  let rawTokenId = null;
  try {
    const privateKey = poolNum === 3 ? process.env.PRIVATE_KEY_3 : process.env.PRIVATE_KEY;
    if (!privateKey) return Response.json({ error: `PRIVATE_KEY${poolNum === 3 ? "_3" : ""} manquant` }, { status: 500 });
    const POOL = getPoolAddress(poolNum);

    rawTokenId = await readTokenIdFromDb(poolNum);
    if (!rawTokenId) return Response.json({ skipped: true, reason: "Aucune position ouverte en DB" });
    const tokenId = BigInt(rawTokenId);

    const rpcUrl = RPC_URLS[0];
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet   = new ethers.Wallet(privateKey, provider);

    // Gauge en dur (24/10) — VOTER.gauges(pool) revert sur le nouveau Voter Aero.
    const gaugeAddr = GAUGE_ADDRESS_2;
    if (!gaugeAddr || gaugeAddr === ethers.ZeroAddress)
      return Response.json({ error: "Gauge introuvable" }, { status: 500 });

    let isStaked = false;
    try {
      const result = await ethCall(gaugeAddr, GAUGE_IFACE.encodeFunctionData("stakedContains", [wallet.address, tokenId]));
      const [staked] = GAUGE_IFACE.decodeFunctionResult("stakedContains", result);
      isStaked = staked;
    } catch (e) {
      console.log(`[collectFees step1 stakedContains] ${e.message ?? e}`);
    }
    console.log(`[collectFees step1 isStaked] ${isStaked}`);

    const usdcBefore = await readBal(USDC, wallet.address).catch(() => 0n);
    const wethBefore = await readBal(WETH, wallet.address).catch(() => 0n);

    // Appel claimEmissions inconditionnellement (23/10, remplace getReward) — si la position n'est
    // pas stakée, la tx échoue et on log sans bloquer la suite.
    try {
      const tx = await sendTx(wallet, { to: gaugeAddr, data: GAUGE_IFACE.encodeFunctionData("claimEmissions", [wallet.address, wallet.address]) });
      await waitForTx(tx);
      console.log(`[collectFees step1 claimEmissions] OK`);
    } catch (e) {
      console.log(`[collectFees step1 claimEmissions] ${e.message ?? e}`);
    }

    const wethAfter = await readBal(WETH, wallet.address).catch(() => 0n);
    const usdcAfter = await readBal(USDC, wallet.address).catch(() => 0n);
    console.log(`[collectFees step1] WETH: ${wethBefore}→${wethAfter} delta=${wethAfter > wethBefore ? wethAfter - wethBefore : 0n}, USDC: ${usdcBefore}→${usdcAfter} delta=${usdcAfter > usdcBefore ? usdcAfter - usdcBefore : 0n}`);

    return Response.json({
      ok: true,
      rawTokenId,
      isStaked,
      nftInWallet: false,
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

    const rpcUrl   = RPC_URLS[0]; // Alchemy en priorité — tx.wait() fiable ~4s
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet   = new ethers.Wallet(privateKey, provider);

    // Vente des fees WETH et swap AERO→USDC désactivés (25/10) — tous deux ciblaient l'ancien
    // routeur/ancien AERO, devenus illiquides après la fusion Aero (21/10), jamais migrés vers le
    // Metarouter. Incident confirmé : wethBefore mal transmis par l'appelant (loop.js, corrigé à
    // part) a fait traiter un dépôt WETH entier comme des "fees", vendu ~0.0832 WETH ($194) pour
    // 3.41 USDC sur ce routeur illiquide (~$190 perdus, irrécupérable). Le WETH collecté reste donc
    // WETH, l'AERO reste AERO — récupérés normalement à la prochaine réouverture / distribution
    // quotidienne de 6h (Règle 4), au lieu d'un swap par événement sur une route non fiable.
    let swapWethHash = null;
    let swapWethError = null;

    let aeroSwapHash = null;
    let aeroUsdcReceived = 0n;
    let aeroBalance = "0";
    let aeroSwapError = null;
    try {
      const aeroBal = await readBal(AERO, wallet.address);
      aeroBalance = ethers.formatUnits(aeroBal, 18);
    } catch (_) {}

    return Response.json({
      ok: true, swapWethHash, aeroSwapHash,
      aeroUsdcReceived: ethers.formatUnits(aeroUsdcReceived, 6),
      aeroBalance,
      ...(swapWethError ? { swapWethError } : {}),
      ...(aeroSwapError ? { aeroSwapError } : {}),
    });
  } catch (e) {
    return Response.json({ error: e.message ?? String(e) }, { status: 500 });
  }
}

// ─── ÉTAPE 3 : transfer + log DB ─────────────────────────────────────────────
async function handleStep3(poolNum, noTransfer, caseNum, body) {
  let rawTokenId = body.rawTokenId ?? null;
  try {
    const privateKey = poolNum === 3 ? process.env.PRIVATE_KEY_3 : process.env.PRIVATE_KEY;
    if (!privateKey) return Response.json({ error: "PRIVATE_KEY manquant" }, { status: 500 });
    const POOL = getPoolAddress(poolNum);

    if (!rawTokenId) {
      rawTokenId = await readTokenIdFromDb(poolNum);
      if (!rawTokenId) return Response.json({ skipped: true, reason: "Aucune position ouverte en DB" });
    }

    const usdcBefore = BigInt(body.usdcBefore ?? "0");

    const rpcUrl  = RPC_URLS[0];
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet   = new ethers.Wallet(privateKey, provider);

    let transferHash = null;
    try {
      const dest = poolNum === 3 ? process.env.DESTINATION_WALLET_3 : process.env.DESTINATION_WALLET;
      if (dest && !noTransfer) {
        const usdcAfter = await readBal(USDC, wallet.address).catch(() => 0n);
        const delta     = usdcAfter > usdcBefore ? usdcAfter - usdcBefore : 0n;
        const toSend    = delta / 2n;
        if (toSend > 0n) {
          const txTransfer = await sendTx(wallet, {
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

    return Response.json({ ok: true, transferHash });
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
  if (!isAuthorized(req)) return unauthorizedResponse();
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
