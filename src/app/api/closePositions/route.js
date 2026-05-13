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

const V2_ROUTER_IFACE = new ethers.Interface([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)",
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
      try {
        const r = await provider.getTransactionReceipt(tx.hash);
        if (r) {
          if (r.status === 0) throw new Error(`revert on-chain (hash=${tx.hash})`);
          return r;
        }
      } catch (pollErr) {
        if (pollErr.message?.startsWith("revert on-chain")) throw pollErr;
        // erreur RPC transitoire (408, timeout) → on continue le polling
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


export async function POST() {
  try {
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) return Response.json({ error: "PRIVATE_KEY manquant" }, { status: 500 });

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
    try {
      const [stakedIds] = await view(gaugeAddr, GAUGE_IFACE, 'stakedValues', [wallet.address]);
      for (const tokenId of stakedIds) {
        // Claim rewards AERO (silencieux)
        try {
          const tx = await wallet.sendTransaction({
            to: gaugeAddr,
            data: GAUGE_IFACE.encodeFunctionData('getReward', [tokenId]),
          });
          await waitForTx(provider, tx);
        } catch (_) {}

        // Simulation — si revert reel (pas juste RPC transient) on skippe ce tokenId
        let simOk = true;
        try {
          await provider.call({
            to: gaugeAddr, from: wallet.address,
            data: GAUGE_IFACE.encodeFunctionData('withdraw', [tokenId]),
          });
        } catch (simErr) {
          const msg = simErr.shortMessage ?? simErr.message ?? '';
          if (msg && !msg.includes('missing revert data')) {
            unstakeErrors.push(`tokenId=${tokenId}: ${msg}`);
            simOk = false;
          }
        }
        if (!simOk) continue;

        try {
          const withdrawData = GAUGE_IFACE.encodeFunctionData('withdraw', [tokenId]);
          let withdrawGas = 300000n;
          try { const est = await provider.estimateGas({ to: gaugeAddr, from: wallet.address, data: withdrawData }); withdrawGas = est * 3n / 2n; } catch (_) {}
          const tx = await wallet.sendTransaction({ to: gaugeAddr, data: withdrawData, gasLimit: withdrawGas });
          await waitForTx(provider, tx);
          unstakedList.push(tokenId.toString());
        } catch (e) {
          unstakeErrors.push(`tokenId=${tokenId}: ${e.shortMessage ?? e.message}`);
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
          // Simulation pour avoir le vrai revert
          try {
            await provider.call({
              to: NFPM, from: wallet.address,
              data: NFPM_IFACE.encodeFunctionData("decreaseLiquidity", [dlParams]),
            });
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
          const tx = await wallet.sendTransaction({ to: NFPM, data: collectData, gasLimit: collectGas });

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

    // 4. Swap tout le WETH → USDC
    let swapHash = null;
    try {
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
              const txApp = await wallet.sendTransaction({
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
        try {
          const txSwap = await wallet.sendTransaction({
            to: SWAP_ROUTER,
            data: SWAP_ROUTER_IFACE.encodeFunctionData("exactInputSingle", [swapParams]),
          });
          swapHash = txSwap.hash;
          await waitForTx(provider, txSwap);
        } catch (e) { swapHash = `FAILED:${e.shortMessage ?? e.message}`; }
      }
    } catch (e) { throw new Error(`[étape 4] ${e.message ?? e.shortMessage}`); }

    // Solde USDC total avant AERO (principal LP + wallet existant, sans AERO)
    const stableBalLp   = await readBal(stablecoin, wallet.address);
    const lpUsdcRaw     = Number(ethers.formatUnits(stableBalLp, 6)).toFixed(2);
    // Principal = solde avant AERO moins fees WETH et USDC accumulées
    const feesInUsdc    = Number(ethers.formatUnits(totalFeesWei0, 18)) * wethPriceUsdc
                        + Number(ethers.formatUnits(totalFeesUsdc1, 6));
    const principalUsdc = Math.max(0, parseFloat(lpUsdcRaw) - feesInUsdc).toFixed(2);

    // 4a. Swap AERO → USDC (non-bloquant)
    let aeroSwapHash = null;
    try {
      const aeroBal = await readBal(AERO, wallet.address);
      const MIN_AERO = ethers.parseUnits("0.01", 18);

      if (aeroBal >= MIN_AERO) {
        const txApp = await wallet.sendTransaction({
          to: AERO,
          data: ERC20_IFACE.encodeFunctionData("approve", [V2_ROUTER, ethers.MaxUint256]),
        });
        await waitForTx(provider, txApp);

        const routes = [{ from: AERO, to: USDC, stable: false, factory: V2_FACTORY }];
        const swapData = V2_ROUTER_IFACE.encodeFunctionData("swapExactTokensForTokens", [
          aeroBal, 0n, routes, wallet.address, freshDeadline(),
        ]);
        const txAeroSwap = await wallet.sendTransaction({ to: V2_ROUTER, data: swapData });
        aeroSwapHash = txAeroSwap.hash;
        await waitForTx(provider, txAeroSwap);
      }
    } catch (_) {}

    // 5. Solde stablecoin final
    const stableBal    = await readBal(stablecoin, wallet.address);
    const finalUsdc    = Number(ethers.formatUnits(stableBal, 6)).toLocaleString("en-US", { minimumFractionDigits: 2 });
    const finalUsdcRaw = Number(ethers.formatUnits(stableBal, 6)).toFixed(2);

    // 6. Mettre à jour usdc_on_close sur les lignes CREATE_OK correspondantes + logger CLOSE_OK
    if (collectedList.length > 0) {
      try {
        for (const tokenId of collectedList) {
          await sql`UPDATE lp_events
                    SET usdc_on_close = ${principalUsdc},
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
    });

  } catch (e) {
    const msg = e.message ?? e.shortMessage ?? String(e);
    await logEvent({ action1: "CLOSE_ERR", error_msg: msg });
    return Response.json({ error: msg }, { status: 500 });
  }
}

