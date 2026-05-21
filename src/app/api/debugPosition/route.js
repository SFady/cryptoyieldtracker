import { ethers } from "ethers";
import { neon }   from "@neondatabase/serverless";

export const runtime = "nodejs";

const sql = neon(process.env.DATABASE_URL);

const NFPM    = "0x827922686190790b37229fd06084350E74485b72";
const POOL    = "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";
const VOTER   = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";

const RPC_URLS = [
  process.env.ALCHEMY_RPC_URL,
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
].filter(Boolean);

const NFPM_IFACE = new ethers.Interface([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getApproved(uint256 tokenId) view returns (address)",
]);

const GAUGE_IFACE = new ethers.Interface([
  "function stakedValues(address depositor) view returns (uint256[])",
  "function depositor(uint256 tokenId) view returns (address)",
]);

const VOTER_IFACE = new ethers.Interface([
  "function gauges(address pool) view returns (address)",
  "function isAlive(address gauge) view returns (bool)",
]);

async function ethCall(to, data) {
  for (const url of RPC_URLS) {
    try {
      const res  = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
        signal: AbortSignal.timeout(6000),
      });
      const json = await res.json();
      if (json.result && json.result !== "0x") return json.result;
    } catch (_) {}
  }
  throw new Error(`eth_call(${to}) failed`);
}

async function tryCall(to, iface, fn, args = []) {
  try {
    const hex    = await ethCall(to, iface.encodeFunctionData(fn, args));
    const result = iface.decodeFunctionResult(fn, hex);
    return { ok: true, value: result.length === 1 ? result[0] : result };
  } catch (e) {
    return { ok: false, error: e.message ?? String(e) };
  }
}

export async function GET(req) {
  const params  = new URL(req.url).searchParams;
  const poolNum = parseInt(params.get("poolNum") ?? "2");

  const privateKey = poolNum === 3 ? process.env.PRIVATE_KEY_3 : process.env.PRIVATE_KEY;
  if (!privateKey) return Response.json({ error: `PRIVATE_KEY${poolNum === 3 ? "_3" : ""} manquant` }, { status: 500 });

  const walletAddr = new ethers.Wallet(privateKey).address;

  // tokenId depuis la DB
  let tokenId = null;
  let tokenIdStr = null;
  try {
    const rows = await sql`
      SELECT token_id FROM lp_events
      WHERE action1 = 'CREATE_OK' AND action2 IS NULL AND token_id IS NOT NULL
        AND COALESCE(pool_num, 2) = ${poolNum}
      ORDER BY id DESC LIMIT 1
    `;
    if (rows[0]?.token_id) {
      tokenId    = BigInt(rows[0].token_id);
      tokenIdStr = rows[0].token_id;
    }
  } catch (e) {
    return Response.json({ error: `DB: ${e.message}` }, { status: 500 });
  }

  if (!tokenId) return Response.json({ error: "Aucun tokenId en DB (CREATE_OK sans CLOSE_OK)" }, { status: 404 });

  // Gauge depuis voter
  const gaugeResult = await tryCall(VOTER, VOTER_IFACE, "gauges", [POOL]);
  const gaugeAddr   = gaugeResult.ok ? gaugeResult.value : null;

  // Appels on-chain parallèles
  const [
    isAliveResult,
    ownerOfResult,
    getApprovedResult,
    stakedValuesResult,
    depositorResult,
  ] = await Promise.all([
    gaugeAddr ? tryCall(VOTER,  VOTER_IFACE, "isAlive",     [gaugeAddr])       : Promise.resolve({ ok: false, error: "gauge introuvable" }),
    tryCall(NFPM,  NFPM_IFACE,  "ownerOf",     [tokenId]),
    tryCall(NFPM,  NFPM_IFACE,  "getApproved", [tokenId]),
    gaugeAddr ? tryCall(gaugeAddr, GAUGE_IFACE, "stakedValues", [walletAddr])  : Promise.resolve({ ok: false, error: "gauge introuvable" }),
    gaugeAddr ? tryCall(gaugeAddr, GAUGE_IFACE, "depositor",   [tokenId])      : Promise.resolve({ ok: false, error: "gauge introuvable" }),
  ]);

  return Response.json({
    poolNum,
    walletAddr,
    tokenId:          tokenIdStr,
    gauge:            gaugeAddr ?? gaugeResult.error,
    isGaugeAlive:     isAliveResult.ok    ? isAliveResult.value    : `ERROR: ${isAliveResult.error}`,
    nftOwner:         ownerOfResult.ok    ? ownerOfResult.value    : `ERROR: ${ownerOfResult.error}`,
    nftApproved:      getApprovedResult.ok ? getApprovedResult.value : `ERROR: ${getApprovedResult.error}`,
    stakedByWallet:   stakedValuesResult.ok ? stakedValuesResult.value.map(String) : `ERROR: ${stakedValuesResult.error}`,
    gaugeDepositor:   depositorResult.ok  ? depositorResult.value  : `ERROR: ${depositorResult.error}`,
    walletIsDepositor: depositorResult.ok ? depositorResult.value?.toLowerCase() === walletAddr.toLowerCase() : null,
  });
}
