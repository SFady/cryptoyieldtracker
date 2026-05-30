import { ethers } from "ethers";
import { POOL_ADDRESS as POOL } from "../../lib/config";

export const runtime = "nodejs";

const VOTER      = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";
const AERO       = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const USDC       = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const V2_ROUTER  = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const V2_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";

const RPC_URLS = [
  process.env.ALCHEMY_RPC_URL,
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
].filter(Boolean);

const VOTER_IFACE = new ethers.Interface([
  "function gauges(address pool) view returns (address)",
]);

const GAUGE_IFACE = new ethers.Interface([
  "function rewardRate() view returns (uint256)",
  "function rewardRate(address token) view returns (uint256)",
  "function periodFinish() view returns (uint256)",
]);

const POOL_IFACE = new ethers.Interface([
  "function fee() view returns (uint24)",
]);

const V2_ROUTER_IFACE = new ethers.Interface([
  "function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)",
]);

async function ethCall(to, data) {
  for (const url of RPC_URLS) {
    try {
      const res  = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
        signal:  AbortSignal.timeout(6000),
      });
      const json = await res.json();
      if (json.result && json.result !== "0x") return json.result;
    } catch (_) {}
  }
  throw new Error(`eth_call(${to}) failed`);
}

export async function GET() {
  try {
    // 1. Gauge address
    const gaugeHex  = await ethCall(VOTER, VOTER_IFACE.encodeFunctionData("gauges", [POOL]));
    const [gaugeAddr] = VOTER_IFACE.decodeFunctionResult("gauges", gaugeHex);
    if (!gaugeAddr || gaugeAddr === ethers.ZeroAddress)
      return Response.json({ error: "Gauge introuvable" }, { status: 500 });

    // 2. rewardRate AERO/sec — essai sans param, fallback avec adresse AERO
    let aeroPerSec = 0;
    try {
      const rrHex = await ethCall(gaugeAddr, GAUGE_IFACE.encodeFunctionData("rewardRate", []));
      const [rr]  = GAUGE_IFACE.decodeFunctionResult("rewardRate()", rrHex);
      aeroPerSec  = parseFloat(ethers.formatUnits(rr, 18));
    } catch (_) {
      try {
        const rrHex = await ethCall(gaugeAddr, GAUGE_IFACE.encodeFunctionData("rewardRate(address)", [AERO]));
        const [rr]  = GAUGE_IFACE.decodeFunctionResult("rewardRate(address)", rrHex);
        aeroPerSec  = parseFloat(ethers.formatUnits(rr, 18));
      } catch (_) {}
    }
    const aeroPerDay = aeroPerSec * 86400;

    // 3. periodFinish — pour signaler si l'époque est expirée
    let epochExpired = false;
    try {
      const pfHex = await ethCall(gaugeAddr, GAUGE_IFACE.encodeFunctionData("periodFinish", []));
      const [pf]  = GAUGE_IFACE.decodeFunctionResult("periodFinish", pfHex);
      epochExpired = Number(pf) < Math.floor(Date.now() / 1000);
    } catch (_) {}

    // 4. Fee tier de la pool
    const feeHex    = await ethCall(POOL, POOL_IFACE.encodeFunctionData("fee", []));
    const [feeBips] = POOL_IFACE.decodeFunctionResult("fee", feeHex);
    const feeRate   = Number(feeBips) / 1_000_000;

    // 5. Prix AERO via getAmountsOut : 1 AERO → USDC
    const routes    = [{ from: AERO, to: USDC, stable: false, factory: V2_FACTORY }];
    const amtsHex   = await ethCall(V2_ROUTER, V2_ROUTER_IFACE.encodeFunctionData("getAmountsOut", [
      ethers.parseUnits("1", 18),
      routes,
    ]));
    const [amounts]   = V2_ROUTER_IFACE.decodeFunctionResult("getAmountsOut", amtsHex);
    const aeroPriceUsd = parseFloat(ethers.formatUnits(amounts[1], 6));

    // 6. Seuil
    const breakEvenDailyVolumeUsd = feeRate > 0
      ? Math.round((aeroPerDay * aeroPriceUsd) / feeRate)
      : null;

    return Response.json({
      gaugeAddr,
      aeroPerDay:              parseFloat(aeroPerDay.toFixed(2)),
      aeroPriceUsd:            parseFloat(aeroPriceUsd.toFixed(4)),
      aeroValuePerDay:         parseFloat((aeroPerDay * aeroPriceUsd).toFixed(2)),
      feeRatePct:              parseFloat((feeRate * 100).toFixed(4)),
      breakEvenDailyVolumeUsd,
      epochExpired,
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
