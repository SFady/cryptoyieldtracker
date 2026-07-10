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

async function getAssetIndex(coin) {
  const meta = await hlInfo({ type: "meta" });
  const idx  = meta.universe.findIndex(a => a.name === coin);
  if (idx === -1) throw new Error(`${coin} asset introuvable dans Hyperliquid meta`);
  return idx;
}

function buildConnectionId(action, nonce) {
  const msgPackBytes = encode(action);
  const nonceHex   = nonce.toString(16).padStart(16, "0");
  const nonceBytes = ethers.getBytes("0x" + nonceHex);
  const zeroAddr   = new Uint8Array(20);
  const combined   = new Uint8Array(msgPackBytes.length + 8 + 20);
  combined.set(msgPackBytes, 0);
  combined.set(nonceBytes, msgPackBytes.length);
  combined.set(zeroAddr, msgPackBytes.length + 8);
  return ethers.keccak256(combined);
}

async function signAndSend(wallet, action, nonce) {
  const connectionId = buildConnectionId(action, nonce);
  const sig = await wallet.signTypedData(
    { chainId: 1337, name: "Exchange", verifyingContract: "0x0000000000000000000000000000000000000000", version: "1" },
    { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
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

function normPx(n) {
  const s = (Math.round(n / 0.1) * 0.1).toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

// Place TP et SL sur une position existante
export async function POST(req) {
  const { tpPrice, slPrice, size, coin = "ETH" } = await req.json().catch(() => ({}));

  if (!tpPrice || !slPrice || !size)
    return Response.json({ error: "tpPrice, slPrice et size requis" }, { status: 400 });

  const privateKey = process.env.PRIVATE_KEY_HL1;
  if (!privateKey) return Response.json({ error: "PRIVATE_KEY_HL1 manquant" }, { status: 500 });

  const wallet   = new ethers.Wallet(privateKey.trim());
  const assetIdx = await getAssetIndex(coin);
  const sizeStr  = parseFloat(size).toFixed(4);

  const slTrigger = normPx(slPrice);
  const slLimit   = normPx(slPrice * 1.02);
  const tpTrigger = normPx(tpPrice);
  const tpLimit   = normPx(tpPrice * 1.02);

  const result = await signAndSend(wallet, {
    type: "order",
    orders: [
      { a: assetIdx, b: true, p: slLimit, s: sizeStr, r: true,
        t: { trigger: { isMarket: true, triggerPx: slTrigger, tpsl: "sl" } } },
      { a: assetIdx, b: true, p: tpLimit, s: sizeStr, r: true,
        t: { trigger: { isMarket: true, triggerPx: tpTrigger, tpsl: "tp" } } },
    ],
    grouping: "positionTpsl",
  }, Date.now());

  if (result.status !== "ok")
    return Response.json({ error: `tpsl échoué : ${JSON.stringify(result)}` }, { status: 500 });

  const statuses = result?.response?.data?.statuses ?? [];
  const slStatus = statuses[0];
  const tpStatus = statuses[1];

  if (slStatus?.error || tpStatus?.error)
    return Response.json({ error: `ordre rejeté : SL=${slStatus?.error} TP=${tpStatus?.error}`, result }, { status: 500 });

  return Response.json({
    ok: true,
    slTrigger: parseFloat(slTrigger),
    tpTrigger: parseFloat(tpTrigger),
    slStatus,
    tpStatus,
  });
}
