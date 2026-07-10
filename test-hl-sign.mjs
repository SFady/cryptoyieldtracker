import { ethers } from "ethers";
import { encode } from "@msgpack/msgpack";

const PRIVATE_KEY = process.env.PRIVATE_KEY_HL1;
if (!PRIVATE_KEY) { console.error("PRIVATE_KEY_HL1 manquant"); process.exit(1); }

const wallet = new ethers.Wallet(PRIVATE_KEY.trim());
console.log("Wallet address:", wallet.address);

function buildConnectionId(action, nonce) {
  const msgPackBytes = encode(action);
  const data = new Uint8Array(msgPackBytes.length + 9);
  data.set(msgPackBytes, 0);
  new DataView(data.buffer).setBigUint64(msgPackBytes.length, BigInt(nonce), false);
  data[msgPackBytes.length + 8] = 0;
  return ethers.keccak256(data);
}

async function signAndSend(action, nonce) {
  const connectionId = buildConnectionId(action, nonce);
  console.log("connectionId:", connectionId);
  const sig = await wallet.signTypedData(
    { chainId: 1337, name: "Exchange", verifyingContract: "0x0000000000000000000000000000000000000000", version: "1" },
    { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    { source: "a", connectionId }
  );
  const { r, s, v } = ethers.Signature.from(sig);
  const body = { action, nonce, signature: { r, s, v }, vaultAddress: null };
  console.log("Body:", JSON.stringify(body));

  const res = await fetch("https://api.hyperliquid.xyz/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await res.json();
  console.log("Result:", JSON.stringify(result, null, 2));
  return result;
}

// Test minimal : cancel tous les ordres ouverts (action "cancel" sans ordres = no-op)
const nonce = Date.now();
const action = { type: "cancel", cancels: [] };
await signAndSend(action, nonce);
