import { ethers } from "ethers";

export const runtime     = "nodejs";
export const maxDuration = 300;

const ARBITRUM_RPCS = [
  "https://arb1.arbitrum.io/rpc",
  "https://arbitrum.drpc.org",
  "https://arbitrum-one.publicnode.com",
].filter(Boolean);

const USDC_ARB       = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const USDC_BASE      = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SPOKE_POOL_ARB = "0xe35e9842fceaca96570b734083f4a58e8f7c165f";
const ARB_CHAIN_ID   = 42161;
const BASE_CHAIN_ID  = 8453;
const ACROSS_API     = "https://app.across.to/api/suggested-fees";
const HL_EXCHANGE    = "https://api.hyperliquid.xyz/exchange";

const ERC20_ABI = ["function approve(address,uint256) returns(bool)", "function balanceOf(address) view returns(uint256)"];
const SPOKE_ABI = [
  "function depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes) payable",
];

async function getArbProvider() {
  for (const url of ARBITRUM_RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(url);
      await p.getBlockNumber();
      return p;
    } catch (_) {}
  }
  throw new Error("RPCs Arbitrum indisponibles");
}

async function getArbUsdcBalance(wallet) {
  const usdc = new ethers.Contract(USDC_ARB, ERC20_ABI, wallet);
  return Number(await usdc.balanceOf(wallet.address)) / 1e6;
}

async function signWithdraw(wallet, action) {
  const sig = await wallet.signTypedData(
    { name: "HyperliquidSignTransaction", version: "1", chainId: 42161, verifyingContract: "0x0000000000000000000000000000000000000000" },
    { "HyperliquidTransaction:Withdraw": [
      { name: "hyperliquidChain", type: "string" },
      { name: "destination",      type: "string" },
      { name: "amount",           type: "string" },
      { name: "time",             type: "uint64"  },
    ]},
    { hyperliquidChain: action.hyperliquidChain, destination: action.destination, amount: action.amount, time: action.time }
  );
  return ethers.Signature.from(sig);
}

async function bridgeArbToBase(wallet, amountUsdc) {
  const amountWei = BigInt(Math.round(amountUsdc * 1e6));

  const quoteUrl = `${ACROSS_API}?inputToken=${USDC_ARB}&outputToken=${USDC_BASE}&originChainId=${ARB_CHAIN_ID}&destinationChainId=${BASE_CHAIN_ID}&amount=${amountWei}&recipient=${wallet.address}`;
  const quoteRes = await fetch(quoteUrl, { signal: AbortSignal.timeout(10000) });
  const quote    = await quoteRes.json();
  if (!quote.totalRelayFee) throw new Error(`Quote Across : ${JSON.stringify(quote)}`);

  const outputAmount        = BigInt(quote.outputAmount);
  const quoteTimestamp      = Number(quote.timestamp);
  const fillDeadline        = Number(quote.fillDeadline);
  const exclusiveRelayer    = quote.exclusiveRelayer ?? ethers.ZeroAddress;
  const exclusivityDeadline = exclusiveRelayer !== ethers.ZeroAddress
    ? quoteTimestamp + Number(quote.exclusivityDeadline ?? 0)
    : 0;
  const spokePoolAddr       = quote.spokePoolAddress ?? SPOKE_POOL_ARB;

  const usdc = new ethers.Contract(USDC_ARB, ERC20_ABI, wallet);
  const approveTx = await usdc.approve(SPOKE_POOL_ARB, amountWei);
  await approveTx.wait();

  const spokePool = new ethers.Contract(spokePoolAddr, SPOKE_ABI, wallet);
  const depositTx = await spokePool.depositV3(
    wallet.address, wallet.address,
    USDC_ARB, USDC_BASE,
    amountWei, outputAmount,
    BASE_CHAIN_ID,
    exclusiveRelayer, quoteTimestamp, fillDeadline, exclusivityDeadline,
    "0x",
  );
  await depositTx.wait();

  return {
    amountIn:  amountUsdc,
    amountOut: (Number(outputAmount) / 1e6).toFixed(2),
    fee:       (amountUsdc - Number(outputAmount) / 1e6).toFixed(2),
    txHash:    depositTx.hash,
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function POST(req) {
  const { amount } = await req.json().catch(() => ({}));
  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0)
    return Response.json({ error: "Montant invalide" }, { status: 400 });

  const privateKeyHl   = process.env.PRIVATE_KEY_HL1;
  const privateKeyPool = process.env.PRIVATE_KEY;
  if (!privateKeyHl)   return Response.json({ error: "PRIVATE_KEY_HL1 manquant" }, { status: 500 });
  if (!privateKeyPool) return Response.json({ error: "PRIVATE_KEY manquant" }, { status: 500 });

  let provider, hlWallet, poolWallet;
  try {
    provider   = await getArbProvider();
    hlWallet   = new ethers.Wallet(privateKeyHl.trim());
    poolWallet = new ethers.Wallet(privateKeyPool.trim(), provider);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }

  // 1. Solde Arbitrum avant retrait
  const balanceBefore = await getArbUsdcBalance(poolWallet);

  // 2. Retrait Hyperliquid → Arbitrum
  const nonce  = Date.now();
  const action = {
    type:             "withdraw3",
    hyperliquidChain: "Mainnet",
    signatureChainId: "0xa4b1",
    amount:           parseFloat(amount).toFixed(2),
    time:             nonce,
    destination:      poolWallet.address,
  };
  const sig    = await signWithdraw(hlWallet, action);
  const hlRes  = await fetch(HL_EXCHANGE, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ action, nonce, signature: { r: sig.r, s: sig.s, v: sig.v } }),
    signal:  AbortSignal.timeout(15000),
  });
  const hlJson = await hlRes.json();
  if (hlJson.status !== "ok")
    return Response.json({ error: `Retrait HL échoué : ${hlJson.response ?? JSON.stringify(hlJson)}` }, { status: 400 });

  // 3. Poll solde Arbitrum (15s × 17 = 255s max, sous la limite 300s)
  const POLL_INTERVAL = 15000;
  const MAX_ATTEMPTS  = 17;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL);
    try {
      const balance = await getArbUsdcBalance(poolWallet);
      if (balance > balanceBefore + 0.5) {
        // 4. Bridge Arbitrum → Base
        try {
          const bridge = await bridgeArbToBase(poolWallet, balance);
          return Response.json({ ok: true, step: "bridged", hlAmount: amount, ...bridge, destination: poolWallet.address });
        } catch (e) {
          return Response.json({ error: `Bridge échoué : ${e.message}`, step: "bridge_error", arbBalance: balance }, { status: 500 });
        }
      }
    } catch (_) {}
  }

  // Timeout — retrait HL accepté mais fonds pas encore arrivés sur Arbitrum
  return Response.json({
    ok:      false,
    pending: true,
    msg:     "Retrait HL accepté mais fonds non reçus sur Arbitrum dans les 4min — relancer /api/hyperliquid-bridge-to-base manuellement",
    destination: poolWallet.address,
  });
}
