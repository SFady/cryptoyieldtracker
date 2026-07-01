import { ethers } from "ethers";
import { encode } from "@msgpack/msgpack";

export const runtime     = "nodejs";
export const maxDuration = 30;

const HL_EXCHANGE = "https://api.hyperliquid.xyz/exchange";
const HL_INFO     = "https://api.hyperliquid.xyz/info";

async function hlInfo(body) {
  const res = await fetch(HL_INFO, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(10000),
  });
  return res.json();
}

function buildConnectionId(action, nonce) {
  const msgPackBytes = encode(action);
  const actionKeccak = ethers.keccak256(msgPackBytes);

  const nonceHex   = nonce.toString(16).padStart(16, "0");
  const nonceBytes = ethers.getBytes("0x" + nonceHex);
  const zeroAddr   = new Uint8Array(20);

  const combined = new Uint8Array(60);
  combined.set(ethers.getBytes(actionKeccak), 0);
  combined.set(nonceBytes, 32);
  combined.set(zeroAddr, 40);

  return ethers.keccak256(combined);
}

async function signAndSend(wallet, action, nonce) {
  const connectionId = buildConnectionId(action, nonce);

  const sig = await wallet.signTypedData(
    {
      chainId:           1337,
      name:              "Exchange",
      verifyingContract: "0x0000000000000000000000000000000000000000",
      version:           "1",
    },
    {
      Agent: [
        { name: "source",       type: "string"  },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    { source: "a", connectionId }
  );

  const { r, s, v } = ethers.Signature.from(sig);

  const res = await fetch(HL_EXCHANGE, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ action, nonce, signature: { r, s, v }, vaultAddress: null }),
    signal:  AbortSignal.timeout(15000),
  });
  return res.json();
}

export async function GET() {
  const privateKey = process.env.PRIVATE_KEY_HL1;
  if (!privateKey) return Response.json({ error: "PRIVATE_KEY_HL1 manquant" }, { status: 500 });
  try {
    const wallet  = new ethers.Wallet(privateKey.trim());
    return Response.json({ address: wallet.address, keyLength: privateKey.length, keyTrimmedLength: privateKey.trim().length });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST() {
  const privateKey = process.env.PRIVATE_KEY_HL1;
  if (!privateKey) return Response.json({ error: "PRIVATE_KEY_HL1 manquant" }, { status: 500 });

  const wallet  = new ethers.Wallet(privateKey);
  const address = wallet.address;

  const [openOrders, meta] = await Promise.all([
    hlInfo({ type: "openOrders", user: address }),
    hlInfo({ type: "meta" }),
  ]);

  if (!Array.isArray(openOrders) || openOrders.length === 0)
    return Response.json({ ok: true, cancelled: 0, message: "Aucun ordre ouvert" });

  const coinToIdx = {};
  meta.universe.forEach((a, i) => { coinToIdx[a.name] = i; });

  const cancels = openOrders
    .filter(o => coinToIdx[o.coin] !== undefined)
    .map(o => ({ a: coinToIdx[o.coin], o: o.oid }));

  if (cancels.length === 0)
    return Response.json({ ok: true, cancelled: 0, message: "Aucun ordre annulable" });

  const nonce  = Date.now();
  const result = await signAndSend(wallet, { type: "cancel", cancels }, nonce);

  return Response.json({
    ok:        result.status === "ok",
    cancelled: cancels.length,
    result,
  });
}
