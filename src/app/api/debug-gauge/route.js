// Endpoint temporaire de diagnostic — supprimable après investigation
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
      if (json.result !== undefined) return json.result;
    } catch (_) {}
  }
  return null;
}

export async function GET() {
  const VOTER   = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";
  const POOL    = "0x3fe04a59ebd38cf06080a6f60a98d124eb59392a";
  const NFPM_OLD = "0x827922686190790b37229fd06084350E74485b72";
  const NFPM_NEW = "0xe1f8cd9ac4e4a65f54f38a5cdafca44f6dd68b53";

  // gauges(address) selector
  const gaugesData = "0xe26d38cf000000000000000000000000" + POOL.substring(2).toLowerCase();
  const gaugeRes = await rpcCall("eth_call", [{ to: VOTER, data: gaugesData }, "latest"]);
  const gaugeAddr = gaugeRes ? "0x" + gaugeRes.substring(26) : null;

  let nftRef = null;
  let nftRefDecoded = null;
  if (gaugeAddr) {
    // nft() selector = 0x47ccca02
    const nftRes = await rpcCall("eth_call", [{ to: gaugeAddr, data: "0x47ccca02" }, "latest"]);
    nftRef = nftRes;
    if (nftRes && nftRes.length >= 66) {
      nftRefDecoded = "0x" + nftRes.substring(26);
    }
  }

  // Also check pool factory
  const factRes = await rpcCall("eth_call", [{ to: POOL, data: "0xc45a0155" }, "latest"]);
  const factDecoded = factRes ? "0x" + factRes.substring(26) : null;

  return Response.json({
    pool: POOL,
    poolFactory: factDecoded,
    gauge: gaugeAddr,
    gaugeNftRef: nftRefDecoded,
    isNfpmOld: nftRefDecoded?.toLowerCase() === NFPM_OLD.toLowerCase(),
    isNfpmNew: nftRefDecoded?.toLowerCase() === NFPM_NEW.toLowerCase(),
    NFPM_OLD,
    NFPM_NEW,
  });
}
