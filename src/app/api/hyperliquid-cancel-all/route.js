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

function normPx(n) {
  const s = (Math.round(n / 0.1) * 0.1).toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
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

async function closePosition(wallet, coinToIdx, coinToDecimals, position, mids, slippagePct) {
  const coin  = position.coin;
  const szi   = parseFloat(position.szi);
  const isBuy = szi < 0;
  const size  = parseFloat(Math.abs(szi).toFixed(coinToDecimals[coin] ?? 4)).toString();
  const mid   = parseFloat(mids[coin]);
  if (!mid || coinToIdx[coin] === undefined) return { coin, error: "asset ou prix introuvable" };
  const closePrice = normPx(isBuy ? mid * (1 + slippagePct) : mid * (1 - slippagePct));
  const result = await signAndSend(wallet, {
    type:   "order",
    orders: [{ a: coinToIdx[coin], b: isBuy, p: closePrice, s: size, r: true, t: { limit: { tif: "Ioc" } } }],
    grouping: "na",
  }, Date.now());
  return { coin, szi, size, closePrice, slippagePct, result };
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

  const wallet  = new ethers.Wallet(privateKey.trim());
  const address = wallet.address;

  const [openOrders, state, meta, mids] = await Promise.all([
    hlInfo({ type: "frontendOpenOrders", user: address }),
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
    await new Promise(r => setTimeout(r, 1000));
  }

  // 2. Close open positions — 3 tentatives avec slippage croissant (5%, 10%, 20%)
  const positions = (state.assetPositions ?? []).filter(p => parseFloat(p.position.szi) !== 0);
  const closeResults = [];
  let failedCoins = [];

  for (const { position } of positions) {
    const freshMids = await hlInfo({ type: "allMids" }).catch(() => mids);
    let result = null;
    for (const slippage of [0.05, 0.10, 0.20]) {
      result = await closePosition(wallet, coinToIdx, coinToDecimals, position, freshMids, slippage);
      closeResults.push(result);
      // Vérifier si l'ordre a rempli (status ok et pas d'erreur dans statuses)
      const statuses = result.result?.response?.data?.statuses ?? [];
      const filled = statuses.some(s => s.filled !== undefined && !s.error);
      if (filled) break;
      // IoC non rempli ou erreur → retenter avec slippage plus grand
      await new Promise(r => setTimeout(r, 800));
    }
    const statuses = result?.result?.response?.data?.statuses ?? [];
    const filled = statuses.some(s => s.filled !== undefined && !s.error);
    if (!filled) failedCoins.push(position.coin);
  }

  // 3. Vérifier que les positions sont bien fermées après les ordres
  let openAfterClose = 0;
  let remainingPositions = [];
  if (positions.length > 0) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      const stateAfter = await hlInfo({ type: "clearinghouseState", user: address });
      const remaining  = (stateAfter.assetPositions ?? []).filter(p => parseFloat(p.position.szi) !== 0);
      openAfterClose       = remaining.length;
      remainingPositions   = remaining.map(p => ({ coin: p.position.coin, szi: p.position.szi }));
    } catch (_) {}
  }

  // 4. Cancel residual orders après fermeture
  let cleanupResult = null;
  if (closeResults.length > 0) {
    await new Promise(r => setTimeout(r, 500));
    const remainingOrders = await hlInfo({ type: "openOrders", user: address });
    const residual = (Array.isArray(remainingOrders) ? remainingOrders : [])
      .filter(o => coinToIdx[o.coin] !== undefined)
      .map(o => ({ a: coinToIdx[o.coin], o: o.oid }));
    if (residual.length > 0) {
      cleanupResult = await signAndSend(wallet, { type: "cancel", cancels: residual }, Date.now());
    }
  }

  const allClosed = openAfterClose === 0;

  return Response.json({
    ok:                 allClosed,
    cancelled:          cancels.length,
    cancelResult,
    closed:             closeResults.length,
    closeResults,
    cleanupResult,
    openAfterClose,
    remainingPositions,
    ...(failedCoins.length > 0 ? { failedCoins } : {}),
    ...(!allClosed ? { error: `${openAfterClose} position(s) HL non fermée(s) après 3 tentatives : ${remainingPositions.map(p => `${p.coin} szi=${p.szi}`).join(", ")}` } : {}),
  }, { status: allClosed ? 200 : 500 });
}
