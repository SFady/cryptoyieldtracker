import { ethers } from "ethers";
import { signL1Action } from "@nktkas/hyperliquid/signing";

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

async function signAndSend(wallet, action, nonce) {
  const sig = await signL1Action({ wallet, action, nonce });

  const res = await fetch(HL_EXCHANGE, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ action, nonce, signature: { r: sig.r, s: sig.s, v: sig.v }, vaultAddress: null }),
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
  const sizeEth  = Math.ceil((sizeUsd / ethPrice) * 10000) / 10000;
  const sizeStr  = sizeEth.toFixed(4);
  const roundTick = (n) => (Math.round(n / 0.1) * 0.1).toFixed(1);
  const priceStr  = roundTick(ethPrice * 0.98);

  // 1. Set isolated leverage
  const levResult = await signAndSend(wallet, {
    type:     "updateLeverage",
    asset:    assetIdx,
    isCross:  false,
    leverage: lev,
  }, Date.now());

  if (levResult.status !== "ok")
    return Response.json({ error: `updateLeverage échoué : ${JSON.stringify(levResult)}` }, { status: 500 });

  // 2. Short IoC (market equivalent)
  const orderResult = await signAndSend(wallet, {
    type:     "order",
    orders:   [{ a: assetIdx, b: false, p: priceStr, s: sizeStr, r: false, t: { limit: { tif: "Ioc" } } }],
    grouping: "na",
  }, Date.now());

  if (orderResult.status !== "ok")
    return Response.json({ error: `order échoué : ${JSON.stringify(orderResult)}` }, { status: 500 });

  const orderStatus = orderResult?.response?.data?.statuses?.[0];
  if (orderStatus?.error)
    return Response.json({ error: `order rejeté : ${orderStatus.error}`, orderResult }, { status: 500 });

  // 3. Stop loss à +5% (clés dans l'ordre du schema : isMarket → triggerPx → tpsl)
  const slTrigger = roundTick(ethPrice * 1.05);
  const slLimit   = roundTick(ethPrice * 1.05 * 1.02);
  let slResult    = null;
  try {
    slResult = await signAndSend(wallet, {
      type:     "order",
      orders:   [{
        a: assetIdx, b: true, p: slLimit, s: sizeStr, r: true,
        t: { trigger: { isMarket: true, triggerPx: slTrigger, tpsl: "sl" } },
      }],
      grouping: "normalTpsl",
    }, Date.now());
  } catch (e) {
    console.error("[hl-short] SL failed:", e.message);
  }

  return Response.json({
    ok:        true,
    ethPrice,
    sizeEth:   parseFloat(sizeStr),
    sizeUsd,
    leverage:  lev,
    priceIoC:  parseFloat(priceStr),
    slPrice:   parseFloat(slTrigger),
    orderResult,
    slResult,
  });
}
