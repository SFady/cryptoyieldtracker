import { ethers } from "ethers";
import { neon }   from "@neondatabase/serverless";

export const runtime     = "nodejs";
export const maxDuration = 120;

const sql = neon(process.env.DATABASE_URL);

const V2_ROUTER  = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const V2_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
const AERO       = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const USDC       = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const POOL       = "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";
const VOTER      = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";

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

const GAUGE_IFACE = new ethers.Interface([
  "function getReward(uint256 tokenId)",
]);

const VOTER_IFACE = new ethers.Interface([
  "function gauges(address pool) view returns (address)",
]);

const V2_ROUTER_IFACE = new ethers.Interface([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)",
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

async function waitForTx(provider, tx) {
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

export async function POST() {
  try {
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) return Response.json({ error: "PRIVATE_KEY manquant" }, { status: 500 });

    // 1. Récupérer le tokenId depuis la DB
    const rows = await sql`
      SELECT token_id FROM lp_events
      WHERE action1 = 'CREATE_OK' AND action2 IS NULL
      ORDER BY id DESC LIMIT 1
    `;
    if (rows.length === 0 || !rows[0].token_id)
      return Response.json({ skipped: true, reason: "Aucune position ouverte en DB" });
    const tokenId = BigInt(rows[0].token_id);

    const rpcUrl   = await pickRpc();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet   = new ethers.Wallet(privateKey, provider);
    const freshDeadline = () => Math.floor(Date.now() / 1000) + 600;

    // 2. Gauge address
    const gaugeHex = await ethCall(VOTER, VOTER_IFACE.encodeFunctionData("gauges", [POOL]));
    const [gaugeAddr] = VOTER_IFACE.decodeFunctionResult("gauges", gaugeHex);
    if (!gaugeAddr || gaugeAddr === ethers.ZeroAddress)
      return Response.json({ error: "Gauge introuvable" }, { status: 500 });

    // 3. Claim AERO depuis le gauge (sans unstaker)
    try {
      const tx = await wallet.sendTransaction({
        to: gaugeAddr,
        data: GAUGE_IFACE.encodeFunctionData("getReward", [tokenId]),
      });
      await waitForTx(provider, tx);
    } catch (e) {
      return Response.json({ error: `[getReward] ${e.message ?? e}` }, { status: 500 });
    }

    // 4. Swap AERO → USDC
    let aeroSwapHash = null;
    const usdcBefore = await readBal(USDC, wallet.address).catch(() => 0n);
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
        const txSwap = await wallet.sendTransaction({ to: V2_ROUTER, data: swapData });
        aeroSwapHash = txSwap.hash;
        await waitForTx(provider, txSwap);
      }
    } catch (_) {}

    // 5. Envoyer le delta USDC vers DESTINATION_WALLET
    let transferHash = null;
    try {
      const dest = process.env.DESTINATION_WALLET;
      if (dest) {
        const usdcAfter = await readBal(USDC, wallet.address).catch(() => 0n);
        const delta = usdcAfter > usdcBefore ? usdcAfter - usdcBefore : 0n;
        console.log(`[claimAero] before=${usdcBefore} after=${usdcAfter} delta=${delta} dest=${dest}`);
        if (delta > 0n) {
          const txTransfer = await wallet.sendTransaction({
            to: USDC,
            data: ERC20_IFACE.encodeFunctionData("transfer", [dest, delta]),
          });
          transferHash = txTransfer.hash;
          await waitForTx(provider, txTransfer);
        }
      }
    } catch (e) {
      console.log(`[claimAero] transfer erreur: ${e.message ?? e}`);
    }

    // 6. Logger en DB
    try {
      await sql`INSERT INTO lp_events (action1, token_id) VALUES ('AERO_CLAIM', ${rows[0].token_id})`;
    } catch (_) {}

    return Response.json({ ok: true, aeroSwapHash, transferHash });

  } catch (e) {
    return Response.json({ error: e.message ?? String(e) }, { status: 500 });
  }
}
