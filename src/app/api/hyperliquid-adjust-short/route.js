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

// POST { targetEth, slPriceTrigger?, tpPriceTrigger?, leverage? }
// Ajuste le short ETH au delta uniquement (pas de close+reopen complet)
// 1. Cancel les trigger orders ETH existants (TP/SL)
// 2. Place un IoC pour le delta (vente si manque, achat si excès)
// 3. Repose TP/SL à la nouvelle taille cible
export async function POST(req) {
  const { targetEth, slPriceTrigger, tpPriceTrigger, leverage = 4 } = await req.json().catch(() => ({}));

  if (!targetEth || targetEth < 0.001)
    return Response.json({ error: "targetEth requis (>= 0.001)" }, { status: 400 });

  const privateKey = process.env.PRIVATE_KEY_HL1;
  if (!privateKey) return Response.json({ error: "PRIVATE_KEY_HL1 manquant" }, { status: 500 });

  const wallet = new ethers.Wallet(privateKey.trim());
  const lev    = Math.max(1, Math.min(50, Math.round(leverage)));

  // 1. Récupérer meta, mid price, position actuelle et ordres ouverts en parallèle
  const [meta, mids, state, openOrders] = await Promise.all([
    hlInfo({ type: "meta" }),
    hlInfo({ type: "allMids" }),
    hlInfo({ type: "clearinghouseState", user: wallet.address }),
    hlInfo({ type: "openOrders", user: wallet.address }),
  ]);

  const assetIdx = meta.universe.findIndex(a => a.name === "ETH");
  if (assetIdx === -1) return Response.json({ error: "ETH introuvable dans meta" }, { status: 500 });

  const midPrice = parseFloat(mids["ETH"]);
  if (!midPrice || isNaN(midPrice)) return Response.json({ error: "Prix ETH introuvable" }, { status: 500 });

  // Position short actuelle
  const ethPos         = (state?.assetPositions ?? []).find(p => p.position?.coin === "ETH");
  const currentSzi     = parseFloat(ethPos?.position?.szi ?? "0");
  const currentShortEth = currentSzi < 0 ? Math.abs(currentSzi) : 0;

  const targetSize = parseFloat(parseFloat(targetEth).toFixed(4));
  const targetStr  = parseFloat(targetSize.toFixed(4)).toString();

  // Delta : positif = besoin de plus de short, négatif = besoin de moins
  const delta    = targetSize - currentShortEth;
  const deltaAbs = Math.abs(delta);
  const deltaStr = parseFloat(deltaAbs.toFixed(4)).toString();

  // 2. Cancel les trigger orders ETH existants (TP/SL) — pas la position
  const ethTriggers = (openOrders ?? []).filter(o => o.coin === "ETH" && o.isTrigger);
  let cancelResult  = null;
  if (ethTriggers.length > 0) {
    const cancels = ethTriggers.map(o => ({ a: assetIdx, o: o.oid }));
    cancelResult  = await signAndSend(wallet, { type: "cancel", cancels }, Date.now());
  }

  // Set leverage si pas de position (première ouverture)
  if (currentShortEth === 0) {
    await signAndSend(wallet, {
      type: "updateLeverage", asset: assetIdx, isCross: false, leverage: lev,
    }, Date.now());
  }

  // 3. Place le delta IoC si significatif (> 0.001 ETH)
  let deltaResult = null;
  if (deltaAbs >= 0.001) {
    const isBuy  = delta < 0; // réduire short = acheter
    const dPrice = normPx(isBuy ? midPrice * 1.05 : midPrice * 0.95);
    deltaResult  = await signAndSend(wallet, {
      type: "order",
      orders: [{ a: assetIdx, b: isBuy, p: dPrice, s: deltaStr, r: false, t: { limit: { tif: "Ioc" } } }],
      grouping: "na",
    }, Date.now());

    const ioStatus = deltaResult?.response?.data?.statuses?.[0];
    if (ioStatus?.error)
      return Response.json({ error: `IoC delta rejeté : ${ioStatus.error}`, deltaResult }, { status: 500 });
  }

  // 4. Reposer TP/SL sur la nouvelle taille cible
  let tpslResult = null;
  if (slPriceTrigger && tpPriceTrigger) {
    const slTrigger = normPx(slPriceTrigger);
    const slLimit   = normPx(slPriceTrigger * 1.02);
    const tpTrigger = normPx(tpPriceTrigger);
    const tpLimit   = normPx(tpPriceTrigger * 1.02);

    tpslResult = await signAndSend(wallet, {
      type: "order",
      orders: [
        { a: assetIdx, b: true, p: slLimit, s: targetStr, r: true,
          t: { trigger: { isMarket: true, triggerPx: slTrigger, tpsl: "sl" } } },
        { a: assetIdx, b: true, p: tpLimit, s: targetStr, r: true,
          t: { trigger: { isMarket: true, triggerPx: tpTrigger, tpsl: "tp" } } },
      ],
      grouping: "positionTpsl",
    }, Date.now());
  }

  return Response.json({
    ok: true,
    currentShortEth,
    targetEth: targetSize,
    delta: parseFloat(delta.toFixed(4)),
    midPrice,
    cancelResult,
    deltaResult,
    tpslResult,
  });
}
