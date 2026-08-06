// Endpoint temporaire de diagnostic — supprimable après investigation
import { ethers } from "ethers";

export const runtime     = "nodejs";
export const maxDuration = 30;

const RPC_URLS = [
  process.env.ALCHEMY_RPC_URL,
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
].filter(Boolean);

async function rpcCall(method, params) {
  for (const url of RPC_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(8000),
      });
      const json = await res.json();
      if (json.result !== undefined && json.result !== null) return json.result;
    } catch (_) {}
  }
  return null;
}

const VOTER_IFACE = new ethers.Interface([
  "function gauges(address pool) view returns (address)",
]);
const NFPM_IFACE = new ethers.Interface([
  "function factory() view returns (address)",
]);

export async function GET() {
  const VOTER    = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";
  const POOL     = "0x3fe04a59ebd38cf06080a6f60a98d124eb59392a";
  const NFPM_OLD = "0x827922686190790b37229fd06084350E74485b72";
  const NFPM_NEW = "0xe1f8cd9ac4e4a65f54f38a5cdafca44f6dd68b53";

  // Pool factory (selector 0xc45a0155)
  const factRaw = await rpcCall("eth_call", [{ to: POOL, data: "0xc45a0155" }, "latest"]);
  const poolFactory = factRaw && factRaw.length >= 66 ? "0x" + factRaw.substring(26) : null;

  // Gauge via ethers-encoded selector (correct ABI encoding)
  const gaugesCalldata = VOTER_IFACE.encodeFunctionData("gauges", [POOL]);
  const gaugeRaw = await rpcCall("eth_call", [{ to: VOTER, data: gaugesCalldata }, "latest"]);
  const gaugeAddr = gaugeRaw && gaugeRaw.length >= 66 ? "0x" + gaugeRaw.substring(26) : null;
  const isZeroGauge = !gaugeAddr || gaugeAddr === "0x0000000000000000000000000000000000000000";

  let nftRef = null;
  let nftRefDecoded = null;
  let gaugeFactoryRef = null;

  if (gaugeAddr && !isZeroGauge) {
    // gauge.nft() = selector 0x47ccca02
    const nftRaw = await rpcCall("eth_call", [{ to: gaugeAddr, data: "0x47ccca02" }, "latest"]);
    nftRef = nftRaw;
    if (nftRaw && nftRaw.length >= 66) nftRefDecoded = "0x" + nftRaw.substring(26);

    // Also check gauge's factory() if it has one — selector 0xc45a0155
    const gFactRaw = await rpcCall("eth_call", [{ to: gaugeAddr, data: "0xc45a0155" }, "latest"]);
    if (gFactRaw && gFactRaw.length >= 66) gaugeFactoryRef = "0x" + gFactRaw.substring(26);

    // NFPM_NEW factory() — verify it matches the new pool factory
  }

  // Also check NFPM_NEW.factory() to confirm it's the right one
  const nfpmNewFactCalldata = NFPM_IFACE.encodeFunctionData("factory");
  const nfpmNewFactRaw = await rpcCall("eth_call", [{ to: NFPM_NEW, data: nfpmNewFactCalldata }, "latest"]);
  const nfpmNewFactory = nfpmNewFactRaw && nfpmNewFactRaw.length >= 66 ? "0x" + nfpmNewFactRaw.substring(26) : null;

  const nfpmOldFactRaw = await rpcCall("eth_call", [{ to: NFPM_OLD, data: nfpmNewFactCalldata }, "latest"]);
  const nfpmOldFactory = nfpmOldFactRaw && nfpmOldFactRaw.length >= 66 ? "0x" + nfpmOldFactRaw.substring(26) : null;

  return Response.json({
    pool:          POOL,
    poolFactory,
    gauge:         isZeroGauge ? "ZERO (no gauge)" : gaugeAddr,
    gaugeNftRef:   nftRefDecoded,
    gaugeFactory:  gaugeFactoryRef,
    isNfpmOld:     nftRefDecoded?.toLowerCase() === NFPM_OLD.toLowerCase(),
    isNfpmNew:     nftRefDecoded?.toLowerCase() === NFPM_NEW.toLowerCase(),
    NFPM_OLD,      nfpmOldFactory,
    NFPM_NEW,      nfpmNewFactory,
    gaugesSelector: gaugesCalldata.substring(0, 10),
  });
}
