import { ethers } from "ethers";

export const runtime     = "nodejs";
export const maxDuration = 120;

const ARBITRUM_RPCS = [
  "https://arb1.arbitrum.io/rpc",
  "https://arbitrum.drpc.org",
  "https://arbitrum-one.publicnode.com",
].filter(Boolean);

const USDC_ARB        = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const USDC_BASE       = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SPOKE_POOL_ARB  = "0xe35e9842fceaca96570b734083f4a58e8f7c165f";
const ARB_CHAIN_ID    = 42161;
const BASE_CHAIN_ID   = 8453;
const ACROSS_API      = "https://app.across.to/api/suggested-fees";

const ERC20_ABI  = ["function approve(address,uint256) returns(bool)", "function balanceOf(address) view returns(uint256)"];
const SPOKE_ABI  = [
  "function depositV3(address depositor,address recipient,address inputToken,address outputToken,uint256 inputAmount,uint256 outputAmount,uint256 destinationChainId,address exclusiveRelayer,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes message) payable",
];

async function getArbProvider() {
  for (const url of ARBITRUM_RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(url);
      await p.getBlockNumber();
      return p;
    } catch (_) {}
  }
  throw new Error("Tous les RPCs Arbitrum sont indisponibles");
}

export async function POST(req) {
  const { amount } = await req.json().catch(() => ({}));
  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0)
    return Response.json({ error: "Montant invalide" }, { status: 400 });

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) return Response.json({ error: "PRIVATE_KEY manquant" }, { status: 500 });

  let provider, wallet;
  try {
    provider = await getArbProvider();
    wallet   = new ethers.Wallet(privateKey.trim(), provider);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }

  const amountWei = BigInt(Math.round(parseFloat(amount) * 1e6));

  // 1. Vérifier solde USDC sur Arbitrum
  const usdc    = new ethers.Contract(USDC_ARB, ERC20_ABI, wallet);
  const balance = await usdc.balanceOf(wallet.address);
  if (balance < amountWei)
    return Response.json({
      error: `Solde USDC Arbitrum insuffisant : ${(Number(balance) / 1e6).toFixed(2)} USDC disponibles`,
    }, { status: 400 });

  // 2. Quote Across
  let quote;
  try {
    const url = `${ACROSS_API}?inputToken=${USDC_ARB}&outputToken=${USDC_BASE}&originChainId=${ARB_CHAIN_ID}&destinationChainId=${BASE_CHAIN_ID}&amount=${amountWei.toString()}&recipient=${wallet.address}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(10000) });
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
  const spokePoolAddr       = quote.spokePoolAddress ?? SPOKE_POOL_ARB;

  // 3. Approve SpokePool
  try {
    const approveTx = await usdc.approve(SPOKE_POOL_ARB, amountWei);
    await approveTx.wait();
  } catch (e) {
    return Response.json({ error: `Approve échoué : ${e.message}` }, { status: 500 });
  }

  // 4. Deposit via Across SpokePool
  const spokePool = new ethers.Contract(spokePoolAddr, SPOKE_ABI, wallet);
  let depositTx;
  try {
    depositTx = await spokePool.depositV3(
      wallet.address,
      wallet.address,
      USDC_ARB,
      USDC_BASE,
      amountWei,
      outputAmount,
      BASE_CHAIN_ID,
      exclusiveRelayer,
      quoteTimestamp,
      fillDeadline,
      exclusivityDeadline,
      "0x",
    );
    await depositTx.wait();
  } catch (e) {
    return Response.json({ error: `Deposit Across échoué : ${e.message}`, quote }, { status: 500 });
  }

  return Response.json({
    ok:          true,
    amountIn:    parseFloat(amount),
    amountOut:   (Number(outputAmount) / 1e6).toFixed(2),
    fee:         (parseFloat(amount) - Number(outputAmount) / 1e6).toFixed(2),
    txHash:      depositTx.hash,
    destination: wallet.address,
    network:     "Base",
  });
}
