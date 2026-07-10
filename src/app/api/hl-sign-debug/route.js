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

  async function testSign(action) {
    const nonce = Date.now();
    const connectionId = buildConnectionId(action, nonce);
    const sig = await wallet.signTypedData(
      { chainId: 1337, name: "Exchange", verifyingContract: "0x0000000000000000000000000000000000000000", version: "1" },
      { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
      { source: "a", connectionId }
    );
    const { r, s, v } = ethers.Signature.from(sig);
    const res = await fetch("https://api.hyperliquid.xyz/exchange", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ action, nonce, signature: { r, s, v }, vaultAddress: null }),
      signal:  AbortSignal.timeout(10000),
    });
    return { connectionId, hlResult: await res.json() };
  }

  // Test 1 : cancel vide (no-op, ne touche rien)
  const cancelResult = await testSign({ type: "cancel", cancels: [] });

  // Test 2 : order IoC très loin du marché (annulé immédiatement, aucun risque)
  // Ordre A : orders AVANT grouping (notre code actuel)
  const orderA = await testSign({
    type: "order",
    orders: [{ a: 1, b: false, p: "100000", s: "0.001", r: false, t: { limit: { tif: "Ioc" } } }],
    grouping: "na",
  });

  // Ordre B : grouping AVANT orders (ordre Python SDK)
  const orderB = await testSign({
    type: "order",
    grouping: "na",
    orders: [{ a: 1, b: false, p: "100000", s: "0.001", r: false, t: { limit: { tif: "Ioc" } } }],
  });

  return Response.json({
    walletAddress: address,
    cancelResult,
    orderA_ordersFirst:   orderA,
    orderB_groupingFirst: orderB,
  });
}
