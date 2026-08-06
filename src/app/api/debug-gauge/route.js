// Endpoint temporaire de diagnostic — supprimable après investigation
import { ethers } from "ethers";
import { neon }   from "@neondatabase/serverless";

export const runtime     = "nodejs";
export const maxDuration = 30;

const sql = neon(process.env.DATABASE_URL);

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
  "function deposit(uint256 tokenId)",
  "function stakedContains(address depositor, uint256 tokenId) view returns (bool)",
]);
const NFPM_IFACE = new ethers.Interface([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function factory() view returns (address)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
]);

async function pickRpc() {
  return new Promise((resolve) => {
    let done = false;
    let pending = RPC_URLS.length;
    for (const url of RPC_URLS) {
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        signal: AbortSignal.timeout(5000),
      })
        .then(r => r.json())
        .then(j => { if (!done && j.result) { done = true; resolve(url); } })
        .catch(() => {})
        .finally(() => { if (--pending === 0 && !done) resolve(RPC_URLS[0]); });
    }
  });
}

export async function GET() {
  const VOTER    = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";
  const POOL     = "0x3fe04a59ebd38cf06080a6f60a98d124eb59392a";
  const NFPM_OLD = "0x827922686190790b37229fd06084350E74485b72";
  const NFPM_NEW = "0xe1f8cd9ac4e4a65f54f38a5cdafca44f6dd68b53";

  const rpcUrl  = await pickRpc();
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  // 1. Récupérer le gauge depuis le VOTER (via ethers provider = Alchemy)
  let gaugeAddr = null;
  let gaugeErr  = null;
  try {
    const raw = await provider.call({ to: VOTER, data: VOTER_IFACE.encodeFunctionData("gauges", [POOL]) });
    const [addr] = VOTER_IFACE.decodeFunctionResult("gauges", raw);
    gaugeAddr = addr;
  } catch (e) { gaugeErr = e.message; }

  const isZeroGauge = !gaugeAddr || gaugeAddr === ethers.ZeroAddress;

  // 2. Trouver le tokenId depuis la DB (dernier CREATE_ERR pool 2 avec token_id)
  let dbTokenId = null;
  let dbErrMsg  = null;
  try {
    const rows = await sql`
      SELECT token_id, error_msg FROM lp_events
      WHERE token_id IS NOT NULL AND COALESCE(pool_num, 2) = 2
      ORDER BY id DESC LIMIT 1
    `;
    if (rows[0]) { dbTokenId = rows[0].token_id; dbErrMsg = rows[0].error_msg; }
  } catch (_) {}

  // 3. Si on a un gauge et un tokenId, diagnostic complet
  let nftRef = null, nftRefFactory = null;
  let ownerOnOld = null, ownerOnNew = null;
  let approvedOnOld = null, approvedOnNew = null;
  let depositSimError = null;
  let isStaked = null;

  if (!isZeroGauge) {
    // gauge.nft() via raw call (selector 0x47ccca02)
    try {
      const raw = await provider.call({ to: gaugeAddr, data: "0x47ccca02" });
      if (raw && raw !== "0x" && raw.length >= 66) {
        nftRef = "0x" + raw.substring(26);
        // factory() du NFPM référencé par le gauge
        const fRaw = await provider.call({ to: nftRef, data: NFPM_IFACE.encodeFunctionData("factory") });
        const [fAddr] = NFPM_IFACE.decodeFunctionResult("factory", fRaw);
        nftRefFactory = fAddr;
      }
    } catch (_) {}

    if (dbTokenId) {
      const tid = BigInt(dbTokenId);
      // Qui possède ce tokenId sur NFPM_OLD et NFPM_NEW ?
      try { const [o] = NFPM_IFACE.decodeFunctionResult("ownerOf", await provider.call({ to: NFPM_OLD, data: NFPM_IFACE.encodeFunctionData("ownerOf", [tid]) })); ownerOnOld = o; } catch (e) { ownerOnOld = `ERR: ${e.message}`; }
      try { const [o] = NFPM_IFACE.decodeFunctionResult("ownerOf", await provider.call({ to: NFPM_NEW, data: NFPM_IFACE.encodeFunctionData("ownerOf", [tid]) })); ownerOnNew = o; } catch (e) { ownerOnNew = `ERR: ${e.message}`; }

      // Approvals
      if (ownerOnOld && !ownerOnOld.startsWith("ERR")) {
        try { const [a] = NFPM_IFACE.decodeFunctionResult("getApproved",      await provider.call({ to: NFPM_OLD, data: NFPM_IFACE.encodeFunctionData("getApproved",      [tid]) }));                    approvedOnOld = a; } catch (_) {}
      }
      if (ownerOnNew && !ownerOnNew.startsWith("ERR")) {
        try { const [a] = NFPM_IFACE.decodeFunctionResult("getApproved",      await provider.call({ to: NFPM_NEW, data: NFPM_IFACE.encodeFunctionData("getApproved",      [tid]) }));                    approvedOnNew = a; } catch (_) {}
      }

      // Simulation deposit
      try {
        await provider.call({ to: gaugeAddr, data: GAUGE_IFACE.encodeFunctionData("deposit", [tid]) });
        depositSimError = "OK (pas de revert)";
      } catch (e) { depositSimError = e.shortMessage ?? e.message; }

      // Déjà staké ?
      try { const [s] = GAUGE_IFACE.decodeFunctionResult("stakedContains", await provider.call({ to: gaugeAddr, data: GAUGE_IFACE.encodeFunctionData("stakedContains", [ethers.ZeroAddress, tid]) })); isStaked = s; } catch (_) {}
    }
  }

  return Response.json({
    rpcUsed: rpcUrl,
    pool:    POOL,
    gauge:   isZeroGauge ? "ZERO_ADDRESS" : gaugeAddr,
    gaugeErr,
    gaugeNftRef:        nftRef,
    gaugeNftRefFactory: nftRefFactory,
    isNfpmOld: nftRef?.toLowerCase() === NFPM_OLD.toLowerCase(),
    isNfpmNew: nftRef?.toLowerCase() === NFPM_NEW.toLowerCase(),
    tokenId:   dbTokenId,
    lastDbErr: dbErrMsg?.substring(0, 200),
    ownerOnOld,
    ownerOnNew,
    approvedOnOld,
    approvedOnNew,
    depositSimError,
    isStaked,
  });
}
