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
  "function deposit(uint256 tokenId, uint256 tokenVeloPair)",
  "function stakedContains(address depositor, uint256 tokenId) view returns (bool)",
]);
const NFPM_IFACE = new ethers.Interface([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function factory() view returns (address)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);
const POOL_IFACE = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function tickSpacing() view returns (int24)",
  "function factory() view returns (address)",
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

async function call(provider, to, iface, fn, args = []) {
  try {
    const raw = await provider.call({ to, data: iface.encodeFunctionData(fn, args) });
    return iface.decodeFunctionResult(fn, raw);
  } catch (e) { return `ERR: ${e.shortMessage ?? e.message}`.substring(0, 200); }
}

export async function GET(req) {
  const p      = new URL(req.url).searchParams;
  const VOTER  = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";
  const POOL   = "0x3fe04a59ebd38cf06080a6f60a98d124eb59392a";
  const NFPM_OLD = "0x827922686190790b37229fd06084350E74485b72";
  const NFPM_NEW = "0xe1f8cd9ac4e4a65f54f38a5cdafca44f6dd68b53";
  const WALLET   = p.get("wallet") ?? null; // optionnel pour vérif staked

  const rpcUrl   = await pickRpc();
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  // 1. Gauge via VOTER
  let gaugeAddr = null;
  try {
    const raw = await provider.call({ to: VOTER, data: VOTER_IFACE.encodeFunctionData("gauges", [POOL]) });
    [gaugeAddr] = VOTER_IFACE.decodeFunctionResult("gauges", raw);
  } catch (e) { gaugeAddr = `ERR: ${e.message}`; }

  const isZeroGauge = !gaugeAddr || gaugeAddr === ethers.ZeroAddress || String(gaugeAddr).startsWith("ERR");

  // 2. TokenId depuis DB
  let dbTokenId = null;
  try {
    const rows = await sql`SELECT token_id FROM lp_events WHERE token_id IS NOT NULL AND COALESCE(pool_num,2)=2 ORDER BY id DESC LIMIT 1`;
    if (rows[0]) dbTokenId = rows[0].token_id;
  } catch (_) {}

  // 3. Données pool on-chain
  const poolToken0     = await call(provider, POOL, POOL_IFACE, "token0");
  const poolToken1     = await call(provider, POOL, POOL_IFACE, "token1");
  const poolTickSpacing = await call(provider, POOL, POOL_IFACE, "tickSpacing");
  const poolFactory    = await call(provider, POOL, POOL_IFACE, "factory");

  // 4. gauge.nft() et gauge.pool()
  let nftRef = null, gaugePool = null;
  if (!isZeroGauge) {
    try {
      const r = await provider.call({ to: gaugeAddr, data: "0x47ccca02" }); // nft()
      if (r && r !== "0x" && r.length >= 66) nftRef = "0x" + r.substring(26);
    } catch (_) {}
    try {
      const r = await provider.call({ to: gaugeAddr, data: "0x16f0115b" }); // pool()
      if (r && r !== "0x" && r.length >= 66) gaugePool = "0x" + r.substring(26);
    } catch (_) {}
  }

  // 5. Données position NFPM_NEW
  let posData = null, posRaw = null;
  if (dbTokenId && !isZeroGauge) {
    const tid = BigInt(dbTokenId);
    try {
      posRaw = await provider.call({ to: NFPM_NEW, data: NFPM_IFACE.encodeFunctionData("positions", [tid]) });
      const dec = NFPM_IFACE.decodeFunctionResult("positions", posRaw);
      posData = {
        token0:      dec.token0,
        token1:      dec.token1,
        tickSpacing: dec.tickSpacing?.toString(),
        liquidity:   dec.liquidity?.toString(),
        tickLower:   dec.tickLower?.toString(),
        tickUpper:   dec.tickUpper?.toString(),
      };
    } catch (e) { posData = `ERR: ${e.shortMessage ?? e.message}`.substring(0, 200); }

    // Comparaison pool vs position
    const tok0Match = Array.isArray(poolToken0) && Array.isArray(posData?.token0 != null) && poolToken0[0]?.toLowerCase() === posData?.token0?.toLowerCase();
    const tok1Match = Array.isArray(poolToken1) && poolToken1[0]?.toLowerCase() === posData?.token1?.toLowerCase();
    const tsMatch   = Array.isArray(poolTickSpacing) && poolTickSpacing[0]?.toString() === posData?.tickSpacing;

    // 6. Simulations deposit (v1 et v2) depuis le wallet propriétaire
    const ownerResult = await call(provider, NFPM_NEW, NFPM_IFACE, "ownerOf", [tid]);
    const owner = Array.isArray(ownerResult) ? ownerResult[0] : null;

    let simV1 = null, simV2 = null;
    if (owner) {
      try { await provider.call({ to: gaugeAddr, from: owner, data: GAUGE_IFACE.encodeFunctionData("deposit(uint256)", [tid]) }); simV1 = "OK"; } catch (e) { simV1 = `ERR: ${e.shortMessage ?? e.message}`.substring(0, 200); }
      try { await provider.call({ to: gaugeAddr, from: owner, data: GAUGE_IFACE.encodeFunctionData("deposit(uint256,uint256)", [tid, 0n]) }); simV2 = "OK"; } catch (e) { simV2 = `ERR: ${e.shortMessage ?? e.message}`.substring(0, 200); }
    }

    // Staked ?
    let isStaked = null;
    if (WALLET) {
      try { const [s] = GAUGE_IFACE.decodeFunctionResult("stakedContains", await provider.call({ to: gaugeAddr, data: GAUGE_IFACE.encodeFunctionData("stakedContains", [WALLET, tid]) })); isStaked = s; } catch (_) {}
    }

    return Response.json({
      rpcUsed: rpcUrl,
      pool: POOL,
      gauge: gaugeAddr,
      gaugePool,                          // pool() du gauge — doit correspondre à POOL
      gaugeNft: nftRef,                   // nft() du gauge — doit être NFPM_NEW
      poolToken0:      Array.isArray(poolToken0)      ? poolToken0[0]      : poolToken0,
      poolToken1:      Array.isArray(poolToken1)      ? poolToken1[0]      : poolToken1,
      poolTickSpacing: Array.isArray(poolTickSpacing) ? poolTickSpacing[0]?.toString() : poolTickSpacing,
      poolFactory:     Array.isArray(poolFactory)     ? poolFactory[0]     : poolFactory,
      tokenId: dbTokenId,
      nftOwner: owner,
      posData,                            // token0/token1/tickSpacing du NFT tel que lu par NFPM_NEW
      tok0Match, tok1Match, tsMatch,      // comparaisons pool vs position (toutes doivent être true)
      simDepositV1: simV1,               // résultat deposit(tokenId) simulé depuis owner
      simDepositV2: simV2,               // résultat deposit(tokenId, 0) simulé depuis owner
      isStaked,
    });
  }

  return Response.json({ rpcUsed: rpcUrl, pool: POOL, gauge: gaugeAddr, gaugePool, gaugeNft: nftRef, tokenId: dbTokenId, poolToken0, poolToken1, poolTickSpacing });
}
