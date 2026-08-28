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

/**
 * POST /api/hyperliquid-trigger-entry
 * Place un trigger stop-sell qui s'ouvre quand le prix descend à triggerPx.
 * Utilisé pour programmer l'entrée en short au centre de la pool.
 * Body: { triggerPx, sizeEth, leverage? }
 */
export async function POST(req) {
  const { triggerPx, sizeEth, leverage = 4 } = await req.json().catch(() => ({}));

  if (!triggerPx || !sizeEth)
    return Response.json({ error: "triggerPx et sizeEth requis" }, { status: 400 });

  const privateKey = process.env.PRIVATE_KEY_HL1;
  if (!privateKey) return Response.json({ error: "PRIVATE_KEY_HL1 manquant" }, { status: 500 });

  try {
    const wallet   = new ethers.Wallet(privateKey.trim());
    const assetIdx = await getEthAssetIndex();

    const lev     = Math.max(1, Math.min(50, Math.round(leverage)));
    const tpxStr  = normPx(triggerPx);
    const limStr  = normPx(triggerPx * 0.98);
    const sizeStr = parseFloat(sizeEth.toFixed(4)).toString();

    // Mettre à jour le levier isolé
    const levResult = await signAndSend(wallet, {
      type: "updateLeverage", asset: assetIdx, isCross: false, leverage: lev,
    }, Date.now());
    if (levResult.status !== "ok")
      return Response.json({ error: `updateLeverage échoué : ${JSON.stringify(levResult)}` }, { status: 500 });

    // Stop-sell : déclenche quand le prix descend à triggerPx → ouvre un short
    const result = await signAndSend(wallet, {
      type:   "order",
      orders: [{
        a: assetIdx, b: false, p: limStr, s: sizeStr, r: false,
        t: { trigger: { isMarket: true, triggerPx: tpxStr, tpsl: "sl" } },
      }],
      grouping: "na",
    }, Date.now());

    if (result.status !== "ok")
      return Response.json({ error: `trigger échoué : ${JSON.stringify(result)}` }, { status: 500 });

    const status = result?.response?.data?.statuses?.[0];
    if (status?.error)
      return Response.json({ error: `trigger rejeté : ${status.error}`, result }, { status: 500 });

    return Response.json({
      ok: true, triggerPx: parseFloat(tpxStr), sizeEth: parseFloat(sizeStr), leverage: lev, status,
    });

  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
