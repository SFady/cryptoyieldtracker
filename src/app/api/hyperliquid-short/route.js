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

// Supprime le zéro de fin : "2835.0" → "2835", "2835.5" → "2835.5"
function normPx(n) {
  const s = (Math.round(n / 0.1) * 0.1).toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
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
  const { sizeUsd, sizeEth: sizeEthDirect, leverage = 2, slPriceTrigger, tpPriceTrigger, noTpsl = false } = await req.json().catch(() => ({}));

  if (!sizeUsd && !sizeEthDirect)
    return Response.json({ error: "sizeUsd ou sizeEth requis" }, { status: 400 });

  const privateKey = process.env.PRIVATE_KEY_HL1;
  if (!privateKey) return Response.json({ error: "PRIVATE_KEY_HL1 manquant" }, { status: 500 });

  const wallet = new ethers.Wallet(privateKey.trim());
  const [ethPrice, assetIdx] = await Promise.all([getEthMidPrice(), getEthAssetIndex()]);

  const lev         = Math.max(1, Math.min(50, Math.round(leverage)));
  const sizeEth     = sizeEthDirect
    ? Math.ceil(sizeEthDirect * 10000) / 10000
    : Math.ceil((sizeUsd * lev / ethPrice) * 10000) / 10000;
  const notionalUsd = sizeEth * ethPrice;
  const sizeStr     = parseFloat(sizeEth.toFixed(4)).toString();
  const priceStr    = normPx(ethPrice * 0.98);

  // 1. Set isolated leverage
  const levResult = await signAndSend(wallet, {
    type: "updateLeverage", asset: assetIdx, isCross: false, leverage: lev,
  }, Date.now());

  if (levResult.status !== "ok")
    return Response.json({ error: `updateLeverage échoué : ${JSON.stringify(levResult)}` }, { status: 500 });

  // 2a. Short IoC sans TP/SL
  if (noTpsl) {
    const result = await signAndSend(wallet, {
      type: "order",
      orders: [{ a: assetIdx, b: false, p: priceStr, s: sizeStr, r: false, t: { limit: { tif: "Ioc" } } }],
      grouping: "na",
    }, Date.now());

    if (result.status !== "ok")
      return Response.json({ error: `order échoué : ${JSON.stringify(result)}` }, { status: 500 });

    const ioStatus = result?.response?.data?.statuses?.[0];
    if (ioStatus?.error)
      return Response.json({ error: `IoC rejeté : ${ioStatus.error}`, result }, { status: 500 });

    return Response.json({
      ok: true, ethPrice, sizeEth: parseFloat(sizeStr),
      marginUsd: sizeUsd, notionalUsd, sizeUsd: notionalUsd,
      leverage: lev, priceIoC: parseFloat(priceStr),
      ioStatus, combinedResult: result,
    });
  }

  // 2b. Short IoC + SL (pas de TP — le cron gère la fermeture quand LP hors range)
  const slBase    = slPriceTrigger ?? ethPrice * 1.05;
  const slTrigger = normPx(slBase);
  const slLimit   = normPx(slBase * 1.02);

  const orders = [
    { a: assetIdx, b: false, p: priceStr, s: sizeStr, r: false, t: { limit: { tif: "Ioc" } } },
    { a: assetIdx, b: true, p: slLimit, s: sizeStr, r: true,
      t: { trigger: { isMarket: true, triggerPx: slTrigger, tpsl: "sl" } } },
  ];
  if (tpPriceTrigger) {
    const tpTrigger = normPx(tpPriceTrigger);
    const tpLimit   = normPx(tpPriceTrigger * 1.02);
    orders.push({ a: assetIdx, b: true, p: tpLimit, s: sizeStr, r: true,
      t: { trigger: { isMarket: true, triggerPx: tpTrigger, tpsl: "tp" } } });
  }

  const combinedResult = await signAndSend(wallet, {
    type: "order",
    orders,
    grouping: "normalTpsl",
  }, Date.now());

  if (combinedResult.status !== "ok")
    return Response.json({ error: `order échoué : ${JSON.stringify(combinedResult)}` }, { status: 500 });

  const statuses = combinedResult?.response?.data?.statuses ?? [];
  const ioStatus = statuses[0];
  const slStatus = statuses[1];
  const tpStatus = tpPriceTrigger ? statuses[2] : null;

  if (ioStatus?.error)
    return Response.json({ error: `IoC rejeté : ${ioStatus.error}`, combinedResult }, { status: 500 });

  return Response.json({
    ok: true, ethPrice, sizeEth: parseFloat(sizeStr),
    marginUsd: sizeUsd, notionalUsd, sizeUsd: notionalUsd,
    leverage: lev, priceIoC: parseFloat(priceStr),
    slTrigger: parseFloat(slTrigger), slLimit: parseFloat(slLimit),
    ioStatus, slStatus, tpStatus, combinedResult,
  });
}
