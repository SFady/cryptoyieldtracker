import { ethers } from "ethers";
import { encode } from "@msgpack/msgpack";

export const runtime     = "nodejs";
export const maxDuration = 30;

function buildConnectionId(action, nonce) {
  const msgPackBytes = encode(action);
  const data = new Uint8Array(msgPackBytes.length + 9);
  data.set(msgPackBytes, 0);
  new DataView(data.buffer).setBigUint64(msgPackBytes.length, BigInt(nonce), false);
  data[msgPackBytes.length + 8] = 0;
  return ethers.keccak256(data);
}

export async function GET() {
  const privateKey = process.env.PRIVATE_KEY_HL1;
  if (!privateKey) return Response.json({ error: "PRIVATE_KEY_HL1 manquant" }, { status: 500 });

  const wallet = new ethers.Wallet(privateKey.trim());
  const address = wallet.address;

  // Test minimal : cancel liste vide (no-op, ne touche rien)
  const action = { type: "cancel", cancels: [] };
  const nonce  = Date.now();

  const connectionId = buildConnectionId(action, nonce);
  const sig = await wallet.signTypedData(
    { chainId: 1337, name: "Exchange", verifyingContract: "0x0000000000000000000000000000000000000000", version: "1" },
    { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    { source: "a", connectionId }
  );
  const { r, s, v } = ethers.Signature.from(sig);
  const body = { action, nonce, signature: { r, s, v }, vaultAddress: null };

  const res = await fetch("https://api.hyperliquid.xyz/exchange", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(10000),
  });
  const hlResult = await res.json();

  return Response.json({
    walletAddress: address,
    keyLength:     privateKey.length,
    connectionId,
    hlResult,
  });
}
