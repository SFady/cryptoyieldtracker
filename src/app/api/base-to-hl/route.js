import { ethers } from "ethers";

export const runtime     = "nodejs";
export const maxDuration = 300;

const BASE_RPCS = [
  process.env.ALCHEMY_RPC_URL,
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
].filter(Boolean);

const ARBITRUM_RPCS = [
  "https://arb1.arbitrum.io/rpc",
  "https://arbitrum.drpc.org",
  "https://arbitrum-one.publicnode.com",
].filter(Boolean);

const USDC_BASE      = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const USDC_ARB       = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const BASE_CHAIN_ID  = 8453;
const ARB_CHAIN_ID   = 42161;
const ACROSS_API     = "https://app.across.to/api/suggested-fees";
const HL_BRIDGE_ARB  = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7"; // Bridge HL sur Arbitrum

const ERC20_ABI  = ["function approve(address,uint256) returns(bool)", "function balanceOf(address) view returns(uint256)"];
const SPOKE_ABI  = ["function depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes) payable"];
const HL_BRIDGE_ABI = ["function deposit(uint64 usd) external"];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getProvider(rpcs) {
  for (const url of rpcs) {
    try {
      const p = new ethers.JsonRpcProvider(url);
      await p.getBlockNumber();
      return p;
    } catch (_) {}
  }
  throw new Error("RPCs indisponibles");
}

async function getUsdcBalance(wallet, usdcAddr) {
  const usdc = new ethers.Contract(usdcAddr, ERC20_ABI, wallet);
  return Number(await usdc.balanceOf(wallet.address)) / 1e6;
}

export async function POST(req) {
  const { amount } = await req.json().catch(() => ({}));
  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) < 5)
    return Response.json({ error: "Montant minimum : $5" }, { status: 400 });

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) return Response.json({ error: "PRIVATE_KEY manquant" }, { status: 500 });

  // Wallets Base et Arbitrum (même clé, chaînes différentes)
  let baseProvider, arbProvider, baseWallet, arbWallet;
  try {
    baseProvider = await getProvider(BASE_RPCS);
    arbProvider  = await getProvider(ARBITRUM_RPCS);
    baseWallet   = new ethers.Wallet(privateKey.trim(), baseProvider);
    arbWallet    = new ethers.Wallet(privateKey.trim(), arbProvider);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }

  const amountWei = BigInt(Math.round(parseFloat(amount) * 1e6));

  // 1. Vérifier solde USDC sur Base
  const usdcBase   = new ethers.Contract(USDC_BASE, ERC20_ABI, baseWallet);
  const balBase    = await usdcBase.balanceOf(baseWallet.address);
  if (balBase < amountWei)
    return Response.json({ error: `Solde USDC Base insuffisant : ${(Number(balBase) / 1e6).toFixed(2)} disponibles` }, { status: 400 });

  // 2. Quote Across Base → Arbitrum
  let quote;
  try {
    const url = `${ACROSS_API}?inputToken=${USDC_BASE}&outputToken=${USDC_ARB}&originChainId=${BASE_CHAIN_ID}&destinationChainId=${ARB_CHAIN_ID}&amount=${amountWei}&recipient=${baseWallet.address}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    quote = await res.json();
    if (!quote.totalRelayFee) throw new Error(JSON.stringify(quote));
  } catch (e) {
    return Response.json({ error: `Quote Across échouée : ${e.message}` }, { status: 500 });
  }

  const outputAmount        = BigInt(quote.outputAmount);
  const quoteTimestamp      = Number(quote.timestamp);
  const fillDeadline        = Number(quote.fillDeadline);
  const exclusiveRelayer    = quote.exclusiveRelayer ?? ethers.ZeroAddress;
  const exclusivityDeadline = exclusiveRelayer !== ethers.ZeroAddress
    ? quoteTimestamp + Number(quote.exclusivityDeadline ?? 0)
    : 0;
  const spokePoolAddr       = quote.spokePoolAddress;

  // 3. Approve + Deposit Across sur Base
  const balArbBefore = await getUsdcBalance(arbWallet, USDC_ARB);

  try {
    const approveTx = await usdcBase.approve(spokePoolAddr, amountWei);
    await approveTx.wait();
  } catch (e) {
    return Response.json({ error: `Approve Base échoué : ${e.message}` }, { status: 500 });
  }

  const spokePool = new ethers.Contract(spokePoolAddr, SPOKE_ABI, baseWallet);
  let bridgeTx;
  try {
    bridgeTx = await spokePool.depositV3(
      baseWallet.address, baseWallet.address,
      USDC_BASE, USDC_ARB,
      amountWei, outputAmount,
      ARB_CHAIN_ID,
      exclusiveRelayer, quoteTimestamp, fillDeadline, exclusivityDeadline,
      "0x",
    );
    await bridgeTx.wait();
  } catch (e) {
    return Response.json({ error: `Bridge Across échoué : ${e.message}`, quote }, { status: 500 });
  }

  // 4. Poll arrivée USDC sur Arbitrum (15s × 16 = 240s)
  const POLL_INTERVAL = 15000;
  const MAX_ATTEMPTS  = 16;
  let arbBalance = balArbBefore;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL);
    try {
      arbBalance = await getUsdcBalance(arbWallet, USDC_ARB);
      if (arbBalance > balArbBefore + 0.5) break;
    } catch (_) {}
    if (i === MAX_ATTEMPTS - 1)
      return Response.json({
        ok: false, pending: true,
        bridgeTxHash: bridgeTx.hash,
        msg: "Bridge envoyé mais USDC pas encore arrivé sur Arbitrum — dépôt HL à faire manuellement via /api/arb-to-hl",
      });
  }

  // 5. Dépôt sur Hyperliquid depuis Arbitrum
  const usdcArb    = new ethers.Contract(USDC_ARB, ERC20_ABI, arbWallet);
  const hlBridge   = new ethers.Contract(HL_BRIDGE_ARB, HL_BRIDGE_ABI, arbWallet);
  const depositAmt = BigInt(Math.round(arbBalance * 1e6));

  try {
    const approveTx = await usdcArb.approve(HL_BRIDGE_ARB, depositAmt);
    await approveTx.wait();
  } catch (e) {
    return Response.json({ error: `Approve HL échoué : ${e.message}`, arbBalance }, { status: 500 });
  }

  let hlTx;
  try {
    hlTx = await hlBridge.deposit(depositAmt);
    await hlTx.wait();
  } catch (e) {
    return Response.json({ error: `Dépôt HL échoué : ${e.message}`, arbBalance }, { status: 500 });
  }

  return Response.json({
    ok:           true,
    amountBase:   parseFloat(amount),
    amountArb:    arbBalance.toFixed(2),
    hlDepositTx:  hlTx.hash,
    bridgeTxHash: bridgeTx.hash,
    destination:  "Hyperliquid",
  });
}
