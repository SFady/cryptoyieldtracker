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

async function getEthMidPrice() {
  const mids  = await hlInfo({ type: "allMids" });
  const price = parseFloat(mids["ETH"]);
  if (!price || isNaN(price)) throw new Error("Prix ETH Hyperliquid introuvable");
  return price;
}

async function getEthAssetIndex() {
  const meta = await hlInfo({ type: "meta" });
  const idx  = meta.universe.findIndex(a => a.name === "ETH");
  if (idx === -1) throw new Error("ETH asset introuvable dans Hyperliquid meta");
  return idx;
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

function normPx(n) {
  const s = (Math.round(n / 0.1) * 0.1).toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

export async function POST(req) {
  const { marginUsd, leverage = 4 } = await req.json().catch(() => ({}));

  if (!marginUsd || marginUsd <= 0)
    return Response.json({ error: "marginUsd requis et > 0" }, { status: 400 });

  const privateKey = process.env.PRIVATE_KEY_HL1;
  if (!privateKey) return Response.json({ error: "PRIVATE_KEY_HL1 manquant" }, { status: 500 });

  const wallet  = new ethers.Wallet(privateKey.trim());
  const address = wallet.address;

  const [ethPrice, assetIdx, clearState, openOrders] = await Promise.all([
    getEthMidPrice(),
    getEthAssetIndex(),
    hlInfo({ type: "clearinghouseState", user: address }),
    hlInfo({ type: "openOrders", user: address }),
  ]);

  // Position ETH actuelle (szi négatif = short)
  const ethPos     = (clearState.assetPositions ?? []).find(p => p.position.coin === "ETH");
  const currentSzi = ethPos ? parseFloat(ethPos.position.szi) : 0;
  const currentEth = currentSzi < 0 ? -currentSzi : 0;

  // Taille cible
  const lev       = Math.max(1, Math.min(50, Math.round(leverage)));
  const targetEth = Math.ceil((marginUsd * lev / ethPrice) * 10000) / 10000;
  const rawDelta  = targetEth - currentEth;
  const absDelta  = Math.ceil(Math.abs(rawDelta) * 10000) / 10000;

  if (absDelta < 0.0001)
    return Response.json({
      ok: true, skipped: true, reason: "Delta trop faible, rien à faire",
      currentEth, targetEth, delta: rawDelta,
    });

  const deltaStr  = absDelta.toFixed(4);
  const targetStr = targetEth.toFixed(4);
  const needBuy   = rawDelta < 0;

  // Ordres TP/SL existants pour ETH
  const ethOrders = (Array.isArray(openOrders) ? openOrders : []).filter(o => o.coin === "ETH");
  const tpOrder   = ethOrders.find(o => o.tpsl === "tp");
  const slOrder   = ethOrders.find(o => o.tpsl === "sl");

  // ── RÉDUCTION ────────────────────────────────────────────────────────────
  if (needBuy) {
    const priceStr = normPx(ethPrice * 1.02);
    const result   = await signAndSend(wallet, {
      type:   "order",
      orders: [{ a: assetIdx, b: true, p: priceStr, s: deltaStr, r: true, t: { limit: { tif: "Ioc" } } }],
      grouping: "na",
    }, Date.now());

    if (result.status !== "ok")
      return Response.json({ error: `order échoué : ${JSON.stringify(result)}` }, { status: 500 });

    const ioStatus = result?.response?.data?.statuses?.[0];
    if (ioStatus?.error)
      return Response.json({ error: `IoC rejeté : ${ioStatus.error}`, result }, { status: 500 });

    return Response.json({
      ok: true, action: "decrease",
      currentEth, targetEth, deltaEth: -absDelta, sizeEth: absDelta, ethPrice,
      note: "TP/SL ajustés automatiquement par Hyperliquid",
      ioStatus,
    });
  }

  // ── AUGMENTATION ─────────────────────────────────────────────────────────
  // 1. Mettre à jour le levier
  const levResult = await signAndSend(wallet, {
    type: "updateLeverage", asset: assetIdx, isCross: false, leverage: lev,
  }, Date.now());
  if (levResult.status !== "ok")
    return Response.json({ error: `updateLeverage échoué : ${JSON.stringify(levResult)}` }, { status: 500 });

  const priceStr = normPx(ethPrice * 0.98);

  // 2a. Si TP/SL existants : placer normalTpsl (IoC delta + nouveaux TP/SL sur taille totale)
  //     → si l'IoC rate, les anciens TP/SL restent actifs (ils n'ont pas été touchés)
  //     → si l'IoC remplit, on annule ensuite les anciens TP/SL
  if (tpOrder && slOrder) {
    const slTrigger = normPx(parseFloat(slOrder.triggerPx));
    const slLimit   = normPx(parseFloat(slOrder.triggerPx) * 1.02);
    const tpTrigger = normPx(parseFloat(tpOrder.triggerPx));
    const tpLimit   = normPx(parseFloat(tpOrder.triggerPx) * 1.02);

    const result = await signAndSend(wallet, {
      type: "order",
      orders: [
        { a: assetIdx, b: false, p: priceStr,  s: deltaStr,  r: false, t: { limit: { tif: "Ioc" } } },
        { a: assetIdx, b: true,  p: slLimit,   s: targetStr, r: true,  t: { trigger: { isMarket: true, triggerPx: slTrigger, tpsl: "sl" } } },
        { a: assetIdx, b: true,  p: tpLimit,   s: targetStr, r: true,  t: { trigger: { isMarket: true, triggerPx: tpTrigger, tpsl: "tp" } } },
      ],
      grouping: "normalTpsl",
    }, Date.now());

    if (result.status !== "ok")
      return Response.json({ error: `order échoué : ${JSON.stringify(result)}` }, { status: 500 });

    const statuses = result?.response?.data?.statuses ?? [];
    const ioStatus = statuses[0];

    if (ioStatus?.error)
      return Response.json({ error: `IoC rejeté : ${ioStatus.error} — anciens TP/SL inchangés`, result }, { status: 500 });

    // IoC rempli → annuler les anciens TP/SL
    const toCancel = [
      { a: assetIdx, o: slOrder.oid },
      { a: assetIdx, o: tpOrder.oid },
    ];
    await new Promise(r => setTimeout(r, 300));
    const cancelResult = await signAndSend(wallet, { type: "cancel", cancels: toCancel }, Date.now());

    return Response.json({
      ok: true, action: "increase",
      currentEth, targetEth, deltaEth: absDelta, sizeEth: absDelta, ethPrice,
      slTrigger, tpTrigger, newSize: targetStr,
      note: "Nouveaux TP/SL créés sur la taille totale, anciens annulés",
      ioStatus, slStatus: statuses[1], tpStatus: statuses[2], cancelResult,
    });
  }

  // 2b. Pas de TP/SL existants → IoC standalone
  const result = await signAndSend(wallet, {
    type:   "order",
    orders: [{ a: assetIdx, b: false, p: priceStr, s: deltaStr, r: false, t: { limit: { tif: "Ioc" } } }],
    grouping: "na",
  }, Date.now());

  if (result.status !== "ok")
    return Response.json({ error: `order échoué : ${JSON.stringify(result)}` }, { status: 500 });

  const ioStatus = result?.response?.data?.statuses?.[0];
  if (ioStatus?.error)
    return Response.json({ error: `IoC rejeté : ${ioStatus.error}`, result }, { status: 500 });

  return Response.json({
    ok: true, action: "increase",
    currentEth, targetEth, deltaEth: absDelta, sizeEth: absDelta, ethPrice,
    note: "Aucun TP/SL existant trouvé — position augmentée sans couverture",
    ioStatus,
  });
}
