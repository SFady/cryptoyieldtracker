import { ethers } from "ethers";
import { neon }   from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

async function logEvent(fields) {
  try {
    await sql`INSERT INTO lp_events (action1, action2, error_msg, usdc_on_close, pool_num)
              VALUES (${fields.action1}, ${fields.action2 ?? null}, ${fields.error_msg ?? null},
                      ${fields.usdc_on_close ?? null}, ${fields.pool_num ?? null})`;
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

export const runtime     = "nodejs";
export const maxDuration = 300;

const NFPM        = "0x827922686190790b37229fd06084350E74485b72";
const SWAP_ROUTER = "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5";
const V2_ROUTER   = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const V2_FACTORY  = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
const WETH        = "0x4200000000000000000000000000000000000006";
const USDC        = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const AERO        = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const POOL        = "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";
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
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

const NFPM_IFACE = new ethers.Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
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

const V2_ROUTER_IFACE = new ethers.Interface([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)",
]);

const POOL_IFACE = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

async function waitForTx(_provider, tx) {
  try {
    const r = await tx.wait();
    if (r?.status === 0) throw new Error("reverted");
    return r;
  } catch (_) {
    for (let i = 0; i < 30; i++) {
      await new Promise(res => setTimeout(res, 2000));
      // Polll via tous les RPCs — évite le rate-limit du RPC principal
      let found = false;
      for (const url of RPC_URLS) {
        try {
          const res  = await fetch(url, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [tx.hash] }),
            signal:  AbortSignal.timeout(6000),
          });
          const json = await res.json();
          if (json.result) {
            if (json.result.status === "0x0") throw new Error(`revert on-chain (hash=${tx.hash})`);
            found = true;
            return json.result;
          }
        } catch (e) {
          if (e.message?.startsWith("revert on-chain")) throw e;
        }
      }
      if (found) break;
    }
    throw new Error(`timeout confirmation tx ${tx.hash}`);
  }
}

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

// eth_call multi-RPC via fetch â€” indÃ©pendant du provider principal (Ã©vite le rate-limit)
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
  throw new Error(`eth_call(${to}) Ã©chouÃ© sur tous les RPCs`);
}

async function view(to, iface, fn, args = []) {
  const hex = await ethCall(to, iface.encodeFunctionData(fn, args));
  return iface.decodeFunctionResult(fn, hex);
}

async function readBal(token, address) {
  const h = await ethCall(token, ERC20_IFACE.encodeFunctionData("balanceOf", [address]));
  return ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], h)[0];
}
// ── Helpers fee calculation (same as positions/route.js) ─────────────────────
const M256 = 1n << 256n;
function mod256(n) { return ((n % M256) + M256) % M256; }
function pad64(n)  { return (((BigInt(n) % M256) + M256) % M256).toString(16).padStart(64, "0"); }
function word(h, i) { const s = h.startsWith("0x") ? h.slice(2) : h; return s.slice(i * 64, (i + 1) * 64); }
function toUint(w) { if (!w || w === "0x") return 0n; const s = w.startsWith("0x") ? w.slice(2) : w; return s ? BigInt("0x" + s) : 0n; }
function toInt(w)  { const n = toUint(w); return n >= M256 / 2n ? n - M256 : n; }
function calcFees(liquidity, fgInside, fgInsideLast, owed) {
  const Q128  = 1n << 128n;
  const delta = mod256(fgInside - fgInsideLast);
  if (delta > (1n << 200n)) return owed;
  return owed + (liquidity * delta) / Q128;
}


export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const poolNum          = body.poolNum ?? 2;
  const caseNum          = body.caseNum ?? null;
  const keepWeth           = body.keepWeth === true;
  const sellWethFees       = body.sellWethFees === true;
  const halfFees           = body.halfFees === true;
  const threeQuarterFees   = body.threeQuarterFees === true;
  const allFees            = body.allFees === true;
  const transferUsdcFees   = body.transferUsdcFees === true;
  const noTransfer         = body.noTransfer === true;
  try {
    const privateKey = poolNum === 3 ? process.env.PRIVATE_KEY_3 : process.env.PRIVATE_KEY;
    if (!privateKey) return Response.json({ error: `PRIVATE_KEY${poolNum === 3 ? "_3" : ""} manquant` }, { status: 500 });

    const rpcUrl   = await pickRpc();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet   = new ethers.Wallet(privateKey, provider);
    const freshDeadline = () => Math.floor(Date.now() / 1000) + 600;

    // 1. Gauge + tickSpacing
    const [gaugeAddr] = await view(VOTER, VOTER_IFACE, "gauges", [POOL]);
    if (!gaugeAddr || gaugeAddr === ethers.ZeroAddress)
      return Response.json({ error: "Gauge introuvable" }, { status: 500 });

    const tsRaw      = await ethCall(POOL, "0xd0c93a7c");
    const tickSpacing = Number(ethers.toBigInt(tsRaw));

    // DÃ©tecter automatiquement le stablecoin du pool (token0 ou token1 selon lequel n'est pas WETH)
    const [poolToken0] = await view(POOL, POOL_IFACE, "token0");
    const [poolToken1] = await view(POOL, POOL_IFACE, "token1");
    const stablecoin = poolToken0.toLowerCase() === WETH.toLowerCase() ? poolToken1 : poolToken0;

    // 2. Unstake toutes les positions du gauge
    const unstakedList  = [];
    const unstakeErrors = [];
    let fallbackDebug   = null;
    try {
      const [stakedIds] = await view(gaugeAddr, GAUGE_IFACE, 'stakedValues', [wallet.address]);
      for (const tokenId of stakedIds) {
        // Claim rewards AERO (silencieux)
        try {
          const tx = await sendTx(wallet, {
            to: gaugeAddr,
            data: GAUGE_IFACE.encodeFunctionData('getReward', [tokenId]),
          });
          await waitForTx(provider, tx);
        } catch (_) {}

        try {
          const withdrawData = GAUGE_IFACE.encodeFunctionData('withdraw', [tokenId]);
          let withdrawGas = 300000n;
          try { const est = await provider.estimateGas({ to: gaugeAddr, from: wallet.address, data: withdrawData }); withdrawGas = est * 3n / 2n; } catch (_) {}
          const tx = await sendTx(wallet, { to: gaugeAddr, data: withdrawData, gasLimit: withdrawGas });
          await waitForTx(provider, tx);
          unstakedList.push(tokenId.toString());
        } catch (e) {
          throw new Error(`[withdraw tokenId=${tokenId}] ${e.shortMessage ?? e.message}`);
        }
      }

      // Fallback DB : si stakedValues retourne vide, utiliser ownerOf pour trouver le vrai gauge
      if (stakedIds.length === 0) {
        const dbRows = await sql`
          SELECT token_id FROM lp_events
          WHERE action1 = 'CREATE_OK' AND action2 IS NULL AND token_id IS NOT NULL
            AND COALESCE(pool_num, 2) = ${poolNum}
          ORDER BY id DESC LIMIT 1
        `;
        if (dbRows[0]?.token_id) {
          const dbTokenId = BigInt(dbRows[0].token_id);
          let actualGauge  = gaugeAddr;
          let ownerAddr    = null;
          let fbWithdrawErr = null;
          try {
            const [owner] = await view(NFPM, NFPM_IFACE, 'ownerOf', [dbTokenId]);
            ownerAddr = owner;
            console.log(`[fallback] tokenId=${dbTokenId} ownerOf=${owner} gaugeAddr(voter)=${gaugeAddr}`);
            if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
              actualGauge = owner;
            }
          } catch (e) {
            console.log(`[fallback] ownerOf error: ${e.message ?? e}`);
          }
          try {
            try {
              const txReward = await sendTx(wallet, { to: actualGauge, data: GAUGE_IFACE.encodeFunctionData('getReward', [dbTokenId]) });
              await waitForTx(provider, txReward);
              console.log(`[fallback] getReward OK actualGauge=${actualGauge}`);
            } catch (e) {
              console.log(`[fallback] getReward error: ${e.message ?? e}`);
            }
            const withdrawData = GAUGE_IFACE.encodeFunctionData('withdraw', [dbTokenId]);
            let withdrawGas = 300000n;
            try {
              const est = await provider.estimateGas({ to: actualGauge, from: wallet.address, data: withdrawData });
              withdrawGas = est * 3n / 2n;
              console.log(`[fallback] estimateGas withdraw OK gas=${withdrawGas}`);
            } catch (e) {
              console.log(`[fallback] estimateGas withdraw error: ${e.message ?? e}`);
            }
            const txW = await sendTx(wallet, { to: actualGauge, data: withdrawData, gasLimit: withdrawGas });
            await waitForTx(provider, txW);
            console.log(`[fallback] withdraw OK tokenId=${dbTokenId} hash=${txW.hash}`);
            unstakedList.push(dbTokenId.toString());
          } catch (e) {
            fbWithdrawErr = e.message ?? String(e);
            console.log(`[fallback] withdraw FAILED: ${fbWithdrawErr}`);
          }
          fallbackDebug = { dbTokenId: dbTokenId.toString(), ownerAddr, gaugeAddr, actualGauge, fbWithdrawErr };
        }
      }
    } catch (e) {
      throw new Error(`[unstake] ${e.shortMessage ?? e.message}`);
    }

    // 3. Toutes les positions NFT dans le wallet (y compris celles qui viennent d'être unstakées)
    const collectedList = [];
    let totalFeesWei0  = 0n;
    let totalFeesUsdc1 = 0n;

    // Donnees globales du pool pour calcul exact des fees (comme dans positions/route.js)
    const [s0Hex, fg0Hex, fg1Hex] = await Promise.all([
      ethCall(POOL, "0x3850c7bd"),  // slot0
      ethCall(POOL, "0xf3058399"),  // feeGrowthGlobal0X128
      ethCall(POOL, "0x46141319"),  // feeGrowthGlobal1X128
    ]);
    const currTick      = Number(toInt(word(s0Hex, 1)));
    const fg0           = toUint(word(fg0Hex, 0));
    const fg1           = toUint(word(fg1Hex, 0));
    const sqrtPf        = Number(toUint(word(s0Hex, 0))) / Number(2n ** 96n);
    const wethPriceUsdc = sqrtPf * sqrtPf * 1e12;
    let principalWei0Acc  = 0n;
    let principalUsdc1Acc = 0n;
    const usdcPreCollect = await readBal(stablecoin, wallet.address).catch(() => 0n);
    try {
      // Combiner les tokenIds unstakés (garantis dans le wallet) + ceux trouvés via balanceOf
      // tokenOfOwnerByIndex peut ne pas refléter immédiatement un NFT fraîchement transféré depuis le gauge
      const tokenIdSet = new Set();
      for (const id of unstakedList) tokenIdSet.add(BigInt(id));
      try {
        const [count] = await view(NFPM, NFPM_IFACE, "balanceOf", [wallet.address]);
        for (let i = 0n; i < count; i++) {
          try {
            const [tid] = await view(NFPM, NFPM_IFACE, "tokenOfOwnerByIndex", [wallet.address, i]);
            tokenIdSet.add(tid);
          } catch (_) { break; }
        }
      } catch (_) {}
      const tokenIds = [...tokenIdSet];

      for (const tokenId of tokenIds) {
        let pos;
        try {
          pos = await view(NFPM, NFPM_IFACE, "positions", [tokenId]);
        } catch (_) { continue; } // position brÃ»lÃ©e ou tokenId invalide â†’ ignorer

        // Filtrer : seulement les positions de ce pool
        if (
          pos.token0.toLowerCase() !== WETH.toLowerCase() ||
          pos.token1.toLowerCase() !== stablecoin.toLowerCase()
        ) continue;

        // Rien Ã  faire : position vide et sans fees
        if (pos.liquidity === 0n && pos.tokensOwed0 === 0n && pos.tokensOwed1 === 0n) continue;

        // Fees exactes = calcFees (identique a l'affichage dans pools -> frais non collectes)
        const tickLower = Number(pos.tickLower);
        const tickUpper = Number(pos.tickUpper);
        try {
          const [tLowHex, tUpHex] = await Promise.all([
            ethCall(POOL, "0xf30dba93" + pad64(tickLower)),
            ethCall(POOL, "0xf30dba93" + pad64(tickUpper)),
          ]);
          const fgLow0 = toUint(word(tLowHex, 3));
          const fgLow1 = toUint(word(tLowHex, 4));
          const fgUp0  = toUint(word(tUpHex,  3));
          const fgUp1  = toUint(word(tUpHex,  4));
          const fgBelow0  = currTick >= tickLower ? fgLow0 : mod256(fg0 - fgLow0);
          const fgBelow1  = currTick >= tickLower ? fgLow1 : mod256(fg1 - fgLow1);
          const fgAbove0  = currTick <  tickUpper  ? fgUp0  : mod256(fg0 - fgUp0);
          const fgAbove1  = currTick <  tickUpper  ? fgUp1  : mod256(fg1 - fgUp1);
          const fgInside0 = mod256(fg0 - fgBelow0 - fgAbove0);
          const fgInside1 = mod256(fg1 - fgBelow1 - fgAbove1);
          totalFeesWei0  += calcFees(pos.liquidity, fgInside0, pos.feeGrowthInside0LastX128, pos.tokensOwed0);
          totalFeesUsdc1 += calcFees(pos.liquidity, fgInside1, pos.feeGrowthInside1LastX128, pos.tokensOwed1);
        } catch (_) {
          totalFeesWei0  += pos.tokensOwed0;
          totalFeesUsdc1 += pos.tokensOwed1;
        }

        // Retirer toute la liquiditÃ© si > 0
        if (pos.liquidity > 0n) {
          const dlParams = {
            tokenId,
            liquidity:  pos.liquidity,
            amount0Min: 0n,
            amount1Min: 0n,
            deadline:   freshDeadline(),
          };
          // Simulation pour avoir le vrai revert + capturer le principal (amount0/amount1 sans fees)
          try {
            const dlSimHex = await provider.call({
              to: NFPM, from: wallet.address,
              data: NFPM_IFACE.encodeFunctionData("decreaseLiquidity", [dlParams]),
            });
            try {
              const [a0, a1] = NFPM_IFACE.decodeFunctionResult("decreaseLiquidity", dlSimHex);
              principalWei0Acc  += BigInt(a0);
              principalUsdc1Acc += BigInt(a1);
            } catch (_) {}
          } catch (simErr) {
            const msg = simErr.shortMessage ?? simErr.message ?? "";
            if (msg && !msg.includes("missing revert data")) {
              throw new Error(`[sim decreaseLiquidity tokenId=${tokenId}] ${msg}`);
            }
          }
          let gasLimit = 400000n;
          try {
            const est = await provider.estimateGas({ to: NFPM, from: wallet.address, data: NFPM_IFACE.encodeFunctionData("decreaseLiquidity", [dlParams]) });
            gasLimit = est * 3n / 2n;
          } catch (_) {}
          try {
            const tx = await sendTx(wallet, {
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

          // Simulation pour obtenir le vrai revert avant d'envoyer la tx
          try {
            await provider.call({ to: NFPM, from: wallet.address, data: collectData });
          } catch (simErr) {
            const simMsg = simErr.shortMessage ?? simErr.message ?? "";
            if (simMsg && !simMsg.includes("missing revert data"))
              throw new Error(`[sim collect] ${simMsg}`);
          }

          let collectGas = 400000n;
          try { const est = await provider.estimateGas({ to: NFPM, from: wallet.address, data: collectData }); collectGas = est * 3n / 2n; } catch (_) {}
          const tx = await sendTx(wallet, { to: NFPM, data: collectData, gasLimit: collectGas });

          try {
            await waitForTx(provider, tx);
          } catch (waitErr) {
            // "could not coalesce error" = ethers ne parse pas la réponse → vérifier le receipt directement
            if ((waitErr.message ?? waitErr.shortMessage ?? "").includes("could not coalesce")) {
              await new Promise(r => setTimeout(r, 3000));
              const receipt = await provider.getTransactionReceipt(tx.hash);
              if (!receipt || receipt.status === 0)
                throw new Error(`revert on-chain collect (hash=${tx.hash})`);
            } else {
              throw waitErr;
            }
          }

          collectedList.push(tokenId.toString());
        } catch (e) {
          throw new Error(`[collect tokenId=${tokenId}] ${e.shortMessage ?? e.message}`);
        }
      }
    } catch (e) {
      throw new Error(e.message); // propage le message dÃ©taillÃ©
    }

    // 4. Swap tout le WETH → USDC (skippé si keepWeth=true)
    const usdcBeforeSwaps = await readBal(stablecoin, wallet.address).catch(() => 0n);
    // Fees USDC réelles = delta balance collect - principal simulé (plus fiable que calcFees on-chain)
    const usdcFromCollect    = usdcBeforeSwaps > usdcPreCollect ? usdcBeforeSwaps - usdcPreCollect : 0n;
    const actualUsdcFeesFromLP = usdcFromCollect > principalUsdc1Acc
      ? usdcFromCollect - principalUsdc1Acc
      : totalFeesUsdc1;
    console.log(`[fees] totalFeesUsdc1=${totalFeesUsdc1} actualUsdcFeesFromLP=${actualUsdcFeesFromLP} principalUsdc1Acc=${principalUsdc1Acc}`);
    let swapHash = null;
    // 4-fees. Si sellWethFees/halfFees/threeQuarterFees/allFees : vendre uniquement les fees WETH (pas le principal)
    if (keepWeth && (sellWethFees || halfFees || threeQuarterFees || allFees) && totalFeesWei0 > 0n) try {
      const wethBal = await readBal(WETH, wallet.address);
      const feeWethToSell = totalFeesWei0 < wethBal ? totalFeesWei0 : wethBal;
      if (feeWethToSell > 0n) {
        try {
          const h = await ethCall(WETH, ERC20_IFACE.encodeFunctionData("allowance", [wallet.address, SWAP_ROUTER]));
          const [current] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], h);
          if (current < feeWethToSell) {
            const txApp = await sendTx(wallet, { to: WETH, data: ERC20_IFACE.encodeFunctionData("approve", [SWAP_ROUTER, ethers.MaxUint256]) });
            await waitForTx(provider, txApp);
          }
        } catch (_) {}
        const swapData = SWAP_ROUTER_IFACE.encodeFunctionData("exactInputSingle", [{
          tokenIn: WETH, tokenOut: stablecoin, tickSpacing,
          recipient: wallet.address, deadline: freshDeadline(),
          amountIn: feeWethToSell, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
        }]);
        let swapGas = 300000n;
        try { const est = await provider.estimateGas({ to: SWAP_ROUTER, from: wallet.address, data: swapData }); swapGas = est * 3n / 2n; } catch (_) {}
        const txFeeSwap = await sendTx(wallet, { to: SWAP_ROUTER, data: swapData, gasLimit: swapGas });
        swapHash = txFeeSwap.hash;
        await waitForTx(provider, txFeeSwap);
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (e) { console.log(`[sellWethFees] ${e.message ?? e}`); }
    if (!keepWeth) try {
      const wethBal = await readBal(WETH, wallet.address);

      if (wethBal > 0n) {
        try {
          let allowanceOk = false;
          try {
            const h = await ethCall(WETH, ERC20_IFACE.encodeFunctionData("allowance", [wallet.address, SWAP_ROUTER]));
            const [current] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], h);
            allowanceOk = current >= wethBal;
          } catch (_) {}
          if (!allowanceOk) {
            let approved = false;
            try {
              const txApp = await sendTx(wallet, {
                to: WETH,
                data: ERC20_IFACE.encodeFunctionData("approve", [SWAP_ROUTER, ethers.MaxUint256]),
              });
              await waitForTx(provider, txApp);
              approved = true;
            } catch (approveErr) {
              await new Promise(r => setTimeout(r, 5000));
              try {
                const h2 = await ethCall(WETH, ERC20_IFACE.encodeFunctionData("allowance", [wallet.address, SWAP_ROUTER]));
                const [cur2] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], h2);
                approved = cur2 >= wethBal;
              } catch (_) {}
              if (!approved) throw approveErr;
            }
          }
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
        const swapData = SWAP_ROUTER_IFACE.encodeFunctionData("exactInputSingle", [swapParams]);
        let swapGas = 300000n;
        try { const est = await provider.estimateGas({ to: SWAP_ROUTER, from: wallet.address, data: swapData }); swapGas = est * 3n / 2n; } catch (_) {}
        try {
          const txSwap = await sendTx(wallet, { to: SWAP_ROUTER, data: swapData, gasLimit: swapGas });
          swapHash = txSwap.hash;
          await waitForTx(provider, txSwap);
          await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
          swapHash = `FAILED:${e.shortMessage ?? e.message}`;
          // Le swap WETH→USDC a échoué mais les positions sont bien fermées — on continue
        }
      }
    } catch (e) { throw new Error(`[étape 4] ${e.message ?? e.shortMessage}`); }
    // end if (!keepWeth)

    // Lecture du solde après WETH fee swap (avant AERO) pour isoler la part AERO
    const usdcAfterWethFeeSwap = (keepWeth && (sellWethFees || halfFees || threeQuarterFees || allFees))
      ? await readBal(stablecoin, wallet.address).catch(() => usdcBeforeSwaps)
      : usdcBeforeSwaps;

    // Solde USDC total avant AERO (principal LP + wallet existant, sans AERO)
    const stableBalLp   = await readBal(stablecoin, wallet.address);
    const lpUsdcRaw     = Number(ethers.formatUnits(stableBalLp, 6)).toFixed(2);
    // Principal = WETH principal converti au prix spot + USDC principal (depuis la sim decreaseLiquidity)
    const principalUsdc = (
      Number(ethers.formatUnits(principalWei0Acc, 18)) * wethPriceUsdc +
      Number(ethers.formatUnits(principalUsdc1Acc, 6))
    ).toFixed(2);

    // 4a. Swap AERO → USDC (non-bloquant)
    let aeroSwapHash = null;
    try {
      const aeroBal = await readBal(AERO, wallet.address);
      const MIN_AERO = ethers.parseUnits("0.01", 18);

      if (aeroBal >= MIN_AERO) {
        const txApp = await sendTx(wallet, {
          to: AERO,
          data: ERC20_IFACE.encodeFunctionData("approve", [V2_ROUTER, ethers.MaxUint256]),
        });
        await waitForTx(provider, txApp);

        const routes = [{ from: AERO, to: USDC, stable: false, factory: V2_FACTORY }];
        const swapData = V2_ROUTER_IFACE.encodeFunctionData("swapExactTokensForTokens", [
          aeroBal, 0n, routes, wallet.address, freshDeadline(),
        ]);
        const txAeroSwap = await sendTx(wallet, { to: V2_ROUTER, data: swapData });
        aeroSwapHash = txAeroSwap.hash;
        await waitForTx(provider, txAeroSwap);
      }
    } catch (_) {}

    // 4b. Transfert des fees converties vers DESTINATION_WALLET (skippé si noTransfer=true)
    try {
      const dest = noTransfer ? null : (poolNum === 3 ? process.env.DESTINATION_WALLET_3 : process.env.DESTINATION_WALLET);
      if (dest) {
        let usdcAfterSwaps = 0n;
        for (let i = 0; i < 4; i++) {
          try { usdcAfterSwaps = await readBal(stablecoin, wallet.address); break; } catch (_) {}
          await new Promise(r => setTimeout(r, 2000));
        }
        const delta = usdcAfterSwaps > usdcBeforeSwaps ? usdcAfterSwaps - usdcBeforeSwaps : 0n;
        const source = caseNum ? `cas${caseNum}` : halfFees ? "cas1" : allFees ? "cas2" : sellWethFees ? "cas1-weth" : transferUsdcFees ? "cas2-old" : keepWeth ? "cas3" : "close";
        let toSend;
        if (halfFees) {
          // CAS 1 : 50% de toutes les fees (WETH fees + USDC fees + AERO) → external
          const wethFeesUsdc = usdcAfterWethFeeSwap > usdcBeforeSwaps ? usdcAfterWethFeeSwap - usdcBeforeSwaps : 0n;
          const aeroUsdc     = usdcAfterSwaps > usdcAfterWethFeeSwap ? usdcAfterSwaps - usdcAfterWethFeeSwap : 0n;
          toSend = (wethFeesUsdc + actualUsdcFeesFromLP + aeroUsdc) / 2n;
        } else if (threeQuarterFees) {
          // CAS 3 : 75% de toutes les fees → external, 25% gardé en wallet
          const wethFeesUsdc = usdcAfterWethFeeSwap > usdcBeforeSwaps ? usdcAfterWethFeeSwap - usdcBeforeSwaps : 0n;
          const aeroUsdc     = usdcAfterSwaps > usdcAfterWethFeeSwap ? usdcAfterSwaps - usdcAfterWethFeeSwap : 0n;
          toSend = (wethFeesUsdc + actualUsdcFeesFromLP + aeroUsdc) * 75n / 100n;
        } else if (allFees) {
          // CAS 2 : 100% de toutes les fees (WETH fees + USDC fees + AERO) → external
          const wethFeesUsdc = usdcAfterWethFeeSwap > usdcBeforeSwaps ? usdcAfterWethFeeSwap - usdcBeforeSwaps : 0n;
          const aeroUsdc     = usdcAfterSwaps > usdcAfterWethFeeSwap ? usdcAfterSwaps - usdcAfterWethFeeSwap : 0n;
          toSend = wethFeesUsdc + actualUsdcFeesFromLP + aeroUsdc;
        } else if (sellWethFees) {
          const wethFeesUsdc = usdcAfterWethFeeSwap > usdcBeforeSwaps ? usdcAfterWethFeeSwap - usdcBeforeSwaps : 0n;
          const aeroUsdc     = usdcAfterSwaps > usdcAfterWethFeeSwap ? usdcAfterSwaps - usdcAfterWethFeeSwap : 0n;
          toSend = wethFeesUsdc + aeroUsdc / 2n;
        } else {
          toSend = delta;
        }
        console.log(`[transfer] before=${usdcBeforeSwaps} afterWethFee=${usdcAfterWethFeeSwap} after=${usdcAfterSwaps} toSend=${toSend} dest=${dest}`);
        if (toSend > 0n) {
          const txTransfer = await sendTx(wallet, {
            to: stablecoin,
            data: ERC20_IFACE.encodeFunctionData("transfer", [dest, toSend]),
          });
          await waitForTx(provider, txTransfer);
          console.log(`[transfer] OK hash=${txTransfer.hash}`);
          try {
            const amt = parseFloat(ethers.formatUnits(toSend, 6));
            await sql`INSERT INTO dest_transfers (amount_usdc, source, tx_hash, pool_num) VALUES (${amt}, ${source + "-aero"}, ${txTransfer.hash}, ${poolNum})`;
          } catch (_) {}
        }
        // transferUsdcFees: envoyer les fees USDC directement vers DESTINATION_WALLET (sans swap)
        if (keepWeth && transferUsdcFees && totalFeesUsdc1 > 0n) {
          try {
            const usdcBal = await readBal(stablecoin, wallet.address).catch(() => 0n);
            const feeUsdcToSend = totalFeesUsdc1 < usdcBal ? totalFeesUsdc1 : usdcBal;
            if (feeUsdcToSend > 0n) {
              const txFeeTransfer = await sendTx(wallet, {
                to: stablecoin,
                data: ERC20_IFACE.encodeFunctionData("transfer", [dest, feeUsdcToSend]),
              });
              await waitForTx(provider, txFeeTransfer);
              console.log(`[transferUsdcFees] OK amount=${feeUsdcToSend} hash=${txFeeTransfer.hash}`);
              try {
                const amt = parseFloat(ethers.formatUnits(feeUsdcToSend, 6));
                await sql`INSERT INTO dest_transfers (amount_usdc, source, tx_hash, pool_num) VALUES (${amt}, ${"cas2-usdc"}, ${txFeeTransfer.hash}, ${poolNum})`;
              } catch (_) {}
            }
          } catch (e) { console.log(`[transferUsdcFees] erreur: ${e.message ?? e}`); }
        }
      }
    } catch (err) {
      console.log(`[transfer] erreur: ${err.message ?? err}`);
    }

    // 5. Solde stablecoin final
    const stableBal    = await readBal(stablecoin, wallet.address);
    const finalUsdc    = Number(ethers.formatUnits(stableBal, 6)).toLocaleString("en-US", { minimumFractionDigits: 2 });
    const finalUsdcRaw = Number(ethers.formatUnits(stableBal, 6)).toFixed(2);
    let wethFinalBal = 0n;
    try { wethFinalBal = await readBal(WETH, wallet.address); } catch (_) {}
    const finalWalletUsdc = parseFloat(
      (Number(ethers.formatUnits(stableBal, 6)) + Number(ethers.formatUnits(wethFinalBal, 18)) * wethPriceUsdc).toFixed(2)
    );

    // 6. Mettre à jour usdc_on_close sur les lignes CREATE_OK correspondantes + logger CLOSE_OK
    if (collectedList.length > 0) {
      try {
        for (const tokenId of collectedList) {
          await sql`UPDATE lp_events
                    SET usdc_on_close = ${finalWalletUsdc},
                        action2       = 'CLOSE_OK',
                        closed_at     = NOW()
                    WHERE token_id = ${tokenId} AND action1 = 'CREATE_OK'`;
        }
      } catch (_) {}
    }

    return Response.json({
      message:      `Tout fermé. Solde final : $${finalUsdc}`,
      unstaked:     unstakedList,
      collected:    collectedList,
      swapHash,
      aeroSwapHash,
      finalUsdc,
      finalUsdcRaw:   parseFloat(finalUsdcRaw),
      lpUsdcRaw:      parseFloat(lpUsdcRaw),
      principalUsdc:  parseFloat(principalUsdc),
      ...(unstakeErrors.length > 0 ? { unstakeWarnings: unstakeErrors } : {}),
      ...(fallbackDebug ? { fallbackDebug } : {}),
    });

  } catch (e) {
    const msg = e.message ?? e.shortMessage ?? String(e);
    await logEvent({ action1: "CLOSE_ERR", error_msg: msg });
    await sendErrorEmail("[CryptoYieldTracker] Erreur — closePositions", `Erreur : ${msg}`);
    return Response.json({ error: msg }, { status: 500 });
  }
}

