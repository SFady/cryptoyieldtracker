import { ethers } from "ethers";
import { encode } from "@msgpack/msgpack";

export const runtime     = "nodejs";
export const maxDuration = 60;

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

async function getEthAssetIndex() {
  const meta = await hlInfo({ type: "meta" });
  const idx  = meta.universe.findIndex(a => a.name === "ETH");
  if (idx === -1) throw new Error("ETH asset introuvable dans Hyperliquid meta");
  return idx;
}

async function getEthMidPrice() {
  const mids  = await hlInfo({ type: "allMids" });
  const price = parseFloat(mids["ETH"]);
  if (!price || isNaN(price)) throw new Error("Prix ETH Hyperliquid introuvable");
  return price;
}

function buildConnectionId(action, nonce) {
  const msgPackBytes = encode(action);

  // layout: msgpack(action) | nonce(8B big-endian) | 0x00 (null vault flag)
  const data = new Uint8Array(msgPackBytes.length + 9);
  data.set(msgPackBytes, 0);
  new DataView(data.buffer).setBigUint64(msgPackBytes.length, BigInt(nonce), false);
  data[msgPackBytes.length + 8] = 0;

  return ethers.keccak256(data);
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
    const wallet = new ethers.Wallet(privateKey.trim());
    return Response.json({ address: wallet.address, keyLength: privateKey.length });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req) {
  const { sizeUsd, leverage = 2 } = await req.json().catch(() => ({}));

  if (!sizeUsd || sizeUsd <= 0)
    return Response.json({ error: "sizeUsd requis et > 0" }, { status: 400 });

  const privateKey = process.env.PRIVATE_KEY_HL1;
  if (!privateKey) return Response.json({ error: "PRIVATE_KEY_HL1 manquant" }, { status: 500 });

  const wallet = new ethers.Wallet(privateKey);

  const [ethPrice, assetIdx] = await Promise.all([getEthMidPrice(), getEthAssetIndex()]);

  const lev      = Math.max(1, Math.min(50, Math.round(leverage)));
  const sizeEth  = sizeUsd / ethPrice;
  const sizeStr  = sizeEth.toFixed(4);
  const priceStr = (ethPrice * 0.98).toFixed(2);

  // 1. Set isolated leverage
  const nonce1    = Date.now();
  const levResult = await signAndSend(wallet, {
    type:     "updateLeverage",
    asset:    assetIdx,
    isCross:  false,
    leverage: lev,
  }, nonce1);

  if (levResult.status !== "ok")
    return Response.json({ error: `updateLeverage échoué : ${JSON.stringify(levResult)}` }, { status: 500 });

  // 2. Short IoC (market equivalent)
  const nonce2      = nonce1 + 1;
  const orderResult = await signAndSend(wallet, {
    type:   "order",
    orders: [{
      a: assetIdx,
      b: false,
      p: priceStr,
      s: sizeStr,
      r: false,
      t: { limit: { tif: "Ioc" } },
    }],
    grouping: "na",
  }, nonce2);

  if (orderResult.status !== "ok")
    return Response.json({ error: `order échoué : ${JSON.stringify(orderResult)}` }, { status: 500 });

  // 3. Stop loss at +5% (buy to close if price rises 5% above entry)
  const slTrigger   = (ethPrice * 1.05).toFixed(2);
  const slLimit     = (ethPrice * 1.05 * 1.02).toFixed(2);
  const nonce3      = nonce2 + 1;
  let slResult      = null;
  try {
    slResult = await signAndSend(wallet, {
      type:   "order",
      orders: [{
        a: assetIdx,
        b: true,
        p: slLimit,
        s: sizeStr,
        r: true,
        t: { trigger: { isMarket: true, tpsl: "sl", triggerPx: slTrigger } },
      }],
      grouping: "na",
    }, nonce3);
  } catch (e) {
    console.error("[hl-short] SL order failed:", e.message);
  }

  return Response.json({
    ok:          true,
    ethPrice,
    sizeEth:     parseFloat(sizeStr),
    sizeUsd,
    leverage:    lev,
    priceIoC:    parseFloat(priceStr),
    slPrice:     parseFloat(slTrigger),
    orderResult,
    slResult,
  });
}
