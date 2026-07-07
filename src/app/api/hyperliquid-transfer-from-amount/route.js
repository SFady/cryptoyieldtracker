import { ethers } from "ethers";

export const runtime     = "nodejs";
export const maxDuration = 60;

const HL_EXCHANGE = "https://api.hyperliquid.xyz/exchange";

async function signWithdraw(wallet, action) {
  const sig = await wallet.signTypedData(
    {
      name:            "HyperliquidSignTransaction",
      version:         "1",
      chainId:         42161,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    {
      "HyperliquidTransaction:Withdraw": [
        { name: "hyperliquidChain", type: "string" },
        { name: "destination",      type: "string" },
        { name: "amount",           type: "string" },
        { name: "time",             type: "uint64"  },
      ],
    },
    {
      hyperliquidChain: action.hyperliquidChain,
      destination:      action.destination,
      amount:           action.amount,
      time:             action.time,
    }
  );
  return ethers.Signature.from(sig);
}

export async function POST(req) {
  const { amount } = await req.json().catch(() => ({}));
  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) < 5)
    return Response.json({ error: "Montant minimum : $5" }, { status: 400 });

  const privateKeyHl   = process.env.PRIVATE_KEY_HL1;
  const privateKeyPool = process.env.PRIVATE_KEY;
  if (!privateKeyHl)   return Response.json({ error: "PRIVATE_KEY_HL1 manquant" }, { status: 500 });
  if (!privateKeyPool) return Response.json({ error: "PRIVATE_KEY manquant" }, { status: 500 });

  let wallet, pool2Address;
  try {
    wallet       = new ethers.Wallet(privateKeyHl.trim());
    pool2Address = new ethers.Wallet(privateKeyPool.trim()).address;
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }

  try {
    const nonce  = Date.now();
    const action = {
      type:             "withdraw3",
      hyperliquidChain: "Mainnet",
      signatureChainId: "0xa4b1",
      amount:           parseFloat(amount).toFixed(2),
      time:             nonce,
      destination:      pool2Address,
    };

    const sig = await signWithdraw(wallet, action);

    const res  = await fetch(HL_EXCHANGE, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ action, nonce, signature: { r: sig.r, s: sig.s, v: sig.v } }),
      signal:  AbortSignal.timeout(15000),
    });
    const json = await res.json();

    if (json.status === "ok")
      return Response.json({ ok: true, amount, destination: pool2Address, result: json });
    return Response.json({ error: json.response ?? JSON.stringify(json) }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
