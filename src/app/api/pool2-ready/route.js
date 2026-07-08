import { ethers } from "ethers";
import { neon } from "@neondatabase/serverless";

export const runtime     = "nodejs";
export const maxDuration = 30;

const HL_INFO  = "https://api.hyperliquid.xyz/info";
const WALLET   = "0xac383af8f62a73a6b156ffa86eb2820bd6a3a2f6";
const NFPM     = "0x827922686190790b37229fd06084350E74485b72";
const VOTER    = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";

const RPC_URLS = [
  process.env.ALCHEMY_RPC_URL,
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://mainnet.base.org",
].filter(Boolean);

async function getProvider() {
  for (const url of RPC_URLS) {
    try {
      const p = new ethers.JsonRpcProvider(url);
      await p.getBlockNumber();
      return p;
    } catch (_) {}
  }
  throw new Error("RPCs Base indisponibles");
}

async function checkNoPool() {
  const provider = await getProvider();

  const voterIface = new ethers.Interface(["function gauges(address pool) view returns (address)"]);
  const nfpmIface  = new ethers.Interface([
    "function balanceOf(address owner) view returns (uint256)",
    "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
    "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  ]);
  const gaugeIface = new ethers.Interface([
    "function stakedValues(address depositor) view returns (uint256[])",
  ]);

  const POOL_ADDRESS = process.env.POOL_ADDRESS;
  if (!POOL_ADDRESS) return true; // pas de pool configuré → pas en pool

  const voter = new ethers.Contract(VOTER, voterIface, provider);
  const gaugeAddr = await voter.gauges(POOL_ADDRESS);

  const gauge = new ethers.Contract(gaugeAddr, gaugeIface, provider);
  const nfpm  = new ethers.Contract(NFPM,  nfpmIface,  provider);

  const [stakedIds, walletBal] = await Promise.all([
    gauge.stakedValues(WALLET).catch(() => []),
    nfpm.balanceOf(WALLET).catch(() => 0n),
  ]);

  if (stakedIds.length > 0) return false;

  // Vérifier les positions non stakées avec liquidité
  const bal = Number(walletBal);
  for (let i = 0; i < bal; i++) {
    const tokenId = await nfpm.tokenOfOwnerByIndex(WALLET, i);
    const pos     = await nfpm.positions(tokenId);
    if (pos.liquidity > 0n) return false;
  }

  return true;
}

async function checkNoHl() {
  const privateKey = process.env.PRIVATE_KEY_HL1;
  if (!privateKey) return true;
  const address = new ethers.Wallet(privateKey.trim()).address;

  const res  = await fetch(HL_INFO, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ type: "clearinghouseState", user: address }),
    signal:  AbortSignal.timeout(10000),
  });
  const state = await res.json();
  const positions = (state.assetPositions ?? []).filter(p => parseFloat(p.position.szi) !== 0);
  return positions.length === 0;
}

export async function GET() {
  try {
    const [noPool, noHl] = await Promise.all([checkNoPool(), checkNoHl()]);
    return Response.json({ ready: noPool && noHl, noPool, noHl });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
