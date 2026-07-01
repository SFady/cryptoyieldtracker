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
  const data = new Uint8Array(msgPackBytes.length + 9);
  data.set(msgPackBytes, 0);
  new DataView(data.buffer).setBigUint64(msgPackBytes.length, BigInt(nonce), false);
  data[msgPackBytes.length + 8] = 0;
  return ethers.keccak256(data);
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

  const [openOrders, state, meta, mids] = await Promise.all([
    hlInfo({ type: "openOrders",         user: address }),
    hlInfo({ type: "clearinghouseState", user: address }),
    hlInfo({ type: "meta" }),
    hlInfo({ type: "allMids" }),
  ]);

  const coinToIdx      = {};
  const coinToDecimals = {};
  meta.universe.forEach((a, i) => {
    coinToIdx[a.name]      = i;
    coinToDecimals[a.name] = a.szDecimals ?? 4;
  });

  // 1. Cancel open orders
  let cancelResult = null;
  const cancels = (Array.isArray(openOrders) ? openOrders : [])
    .filter(o => coinToIdx[o.coin] !== undefined)
    .map(o => ({ a: coinToIdx[o.coin], o: o.oid }));

  if (cancels.length > 0) {
    cancelResult = await signAndSend(wallet, { type: "cancel", cancels }, Date.now());
  }

  // 2. Close open positions (IoC market close, reduce only)
  const positions = (state.assetPositions ?? []).filter(p => parseFloat(p.position.szi) !== 0);
  const closeResults = [];

  for (const { position } of positions) {
    const coin  = position.coin;
    const szi   = parseFloat(position.szi);
    const isBuy = szi < 0;
    const size  = Math.abs(szi).toFixed(coinToDecimals[coin] ?? 4);
    const mid   = parseFloat(mids[coin]);
    if (!mid || coinToIdx[coin] === undefined) {
      closeResults.push({ coin, error: "asset ou prix introuvable" });
      continue;
    }
    const rawPrice   = isBuy ? mid * 1.04 : mid * 0.96;
    const closePrice = (Math.round(rawPrice / 0.1) * 0.1).toFixed(1);

    const result = await signAndSend(wallet, {
      type:   "order",
      orders: [{ a: coinToIdx[coin], b: isBuy, p: closePrice, s: size, r: true, t: { limit: { tif: "Ioc" } } }],
      grouping: "na",
    }, Date.now());

    closeResults.push({ coin, szi, size, closePrice, result });
  }

  return Response.json({
    ok:           true,
    cancelled:    cancels.length,
    cancelResult,
    closed:       closeResults.length,
    closeResults,
  });
}
