import { ethers } from "ethers";
import { encode } from "@msgpack/msgpack";

export const runtime     = "nodejs";
export const maxDuration = 60;

const HL_EXCHANGE = "https://api.hyperliquid.xyz/exchange";

async function signAction(wallet, action, nonce) {
  const msgpackBytes = encode({ method: "POST", path: "/exchange", body: { action, nonce } });
  const hash = ethers.keccak256(
    ethers.concat([
      ethers.toUtf8Bytes("\x19Ethereum Signed Message:\n"),
      ethers.toUtf8Bytes(String(msgpackBytes.length)),
      msgpackBytes,
    ])
  );
  const sig = wallet.signingKey.sign(hash);
  return { r: sig.r, s: sig.s, v: sig.v };
}

export async function POST(req) {
  const { amount } = await req.json().catch(() => ({}));
  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0)
    return Response.json({ error: "Montant invalide" }, { status: 400 });

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

    const sig = await signAction(wallet, action, nonce);

    const res  = await fetch(HL_EXCHANGE, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ action, nonce, signature: sig }),
      signal:  AbortSignal.timeout(15000),
    });
    const json = await res.json();

    if (json.status === "ok") return Response.json({ ok: true, amount, destination: pool2Address, result: json });
    return Response.json({ error: json.response ?? JSON.stringify(json) }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
