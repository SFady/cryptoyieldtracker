import { ethers } from "ethers";
import { encode } from "@msgpack/msgpack";

export const runtime     = "nodejs";
export const maxDuration = 30;

function buildConnectionId(action, nonce) {
  const msgPackBytes = encode(action);
  const data = new Uint8Array(msgPackBytes.length + 9);
  data.set(msgPackBytes, 0);
  new DataView(data.buffer).setBigUint64(msgPackBytes.length, BigInt(nonce), false);
  data[msgPackBytes.length + 8] = 0;
  return ethers.keccak256(data);
}

export async function GET() {
  const privateKey = process.env.PRIVATE_KEY_HL1;
  if (!privateKey) return Response.json({ error: "PRIVATE_KEY_HL1 manquant" }, { status: 500 });

  const wallet = new ethers.Wallet(privateKey.trim());
  const address = wallet.address;

  async function testSign(action) {
    const nonce = Date.now();
    const connectionId = buildConnectionId(action, nonce);
    const sig = await wallet.signTypedData(
      { chainId: 1337, name: "Exchange", verifyingContract: "0x0000000000000000000000000000000000000000", version: "1" },
      { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
      { source: "a", connectionId }
    );
    const { r, s, v } = ethers.Signature.from(sig);
    const res = await fetch("https://api.hyperliquid.xyz/exchange", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ action, nonce, signature: { r, s, v }, vaultAddress: null }),
      signal:  AbortSignal.timeout(10000),
    });
    return { connectionId, hlResult: await res.json() };
  }

  // Récupérer meta + state + mids comme cancel-all
  const hlInfo = (body) => fetch("https://api.hyperliquid.xyz/info", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then(r => r.json());

  const [meta, mids, state] = await Promise.all([
    hlInfo({ type: "meta" }),
    hlInfo({ type: "allMids" }),
    hlInfo({ type: "clearinghouseState", user: address }),
  ]);

  const coinToIdx = {};
  const coinToDecimals = {};
  meta.universe.forEach((a, i) => { coinToIdx[a.name] = i; coinToDecimals[a.name] = a.szDecimals ?? 4; });

  const ethIdx  = coinToIdx["ETH"];
  const ethMid  = parseFloat(mids["ETH"]);

  function normPx(n) {
    const s = (Math.round(n / 0.1) * 0.1).toFixed(1);
    return s.endsWith(".0") ? s.slice(0, -2) : s;
  }

  // Position ETH réelle
  const ethPos = (state.assetPositions ?? []).find(p => p.position.coin === "ETH");
  const szi    = ethPos ? parseFloat(ethPos.position.szi) : 0;

  // Reproduire EXACTEMENT l'action de cancel-all (mais prix à 1$ pour ne pas filler)
  const isBuy = szi < 0;
  const size  = szi !== 0 ? Math.abs(szi).toFixed(coinToDecimals["ETH"] ?? 4) : "0.0010";
  const safeClosePrice = normPx(isBuy ? 1 : 999999);  // loin du marché, IoC annule immédiatement

  const exactCancelAllAction = {
    type:   "order",
    orders: [{ a: ethIdx, b: isBuy, p: safeClosePrice, s: size, r: true, t: { limit: { tif: "Ioc" } } }],
    grouping: "na",
  };

  const exactTest = await testSign(exactCancelAllAction);

  // Test référence : identique mais a=1 hardcodé et s sans zéro de fin
  const refAction = {
    type:   "order",
    orders: [{ a: 1, b: false, p: "1", s: "0.001", r: false, t: { limit: { tif: "Ioc" } } }],
    grouping: "na",
  };
  const refTest = await testSign(refAction);

  return Response.json({
    walletAddress: address,
    ethIdx,
    ethMid,
    szi,
    exactCancelAllAction,
    exactTest,
    refTest,
  });
}
