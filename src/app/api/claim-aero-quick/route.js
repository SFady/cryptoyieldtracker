import { ethers } from 'ethers';
import { neon }   from '@neondatabase/serverless';
import { getPoolAddress } from '../../lib/config';

export const runtime     = 'nodejs';
export const maxDuration = 30;

const VOTER  = '0x16613524e02ad97eDfeF371bC883F2F5d6C480A5';
const WETH   = '0x4200000000000000000000000000000000000006';
const AERO   = '0x940181a94A35A4569E4529A3CDfB74e38FD98631';

const RPC_URLS = [
  process.env.ALCHEMY_RPC_URL,
  'https://base.drpc.org',
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
  'https://mainnet.base.org',
].filter(Boolean);

const VOTER_IFACE = new ethers.Interface([
  'function gauges(address pool) view returns (address)',
]);
const GAUGE_IFACE = new ethers.Interface([
  'function getReward(uint256 tokenId)',
  'function earned(address token, uint256 tokenId) view returns (uint256)',
]);
const ERC20_IFACE = new ethers.Interface([
  'function balanceOf(address) view returns (uint256)',
]);

async function ethCall(to, data) {
  for (const url of RPC_URLS) {
    try {
      const res  = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
        signal: AbortSignal.timeout(6000),
      });
      const json = await res.json();
      if (json.result && json.result !== '0x') return json.result;
    } catch (_) {}
  }
  throw new Error(`eth_call(${to}) failed`);
}

async function pickRpc() {
  return new Promise((resolve) => {
    let done = false;
    let pending = RPC_URLS.length;
    for (const url of RPC_URLS) {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
        signal: AbortSignal.timeout(4000),
      })
        .then(r => r.json())
        .then(j => { if (!done && j.result) { done = true; resolve(url); } })
        .catch(() => {})
        .finally(() => { if (--pending === 0 && !done) resolve(RPC_URLS[0]); });
    }
  });
}

// POST /api/claim-aero-quick
// Body: { tokenId?: number, poolNum?: number }
// Si tokenId absent, cherche le dernier CLOSE_OK en DB.
export async function POST(req) {
  const body    = await req.json().catch(() => ({}));
  const poolNum = body.poolNum ?? 2;
  const steps   = [];

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) return Response.json({ error: 'PRIVATE_KEY manquant' }, { status: 500 });

  try {
    // Résoudre le tokenId
    let tokenId = body.tokenId ? BigInt(body.tokenId) : null;
    if (!tokenId) {
      const sql  = neon(process.env.DATABASE_URL);
      const rows = await sql`
        SELECT token_id FROM lp_events
        WHERE action2 = 'CLOSE_OK' AND token_id IS NOT NULL
          AND COALESCE(pool_num, 2) = ${poolNum}
        ORDER BY id DESC LIMIT 1`;
      if (!rows[0]?.token_id) return Response.json({ error: 'Aucun tokenId trouvé en DB' }, { status: 404 });
      tokenId = BigInt(rows[0].token_id);
    }
    steps.push(`tokenId = ${tokenId}`);

    const POOL = getPoolAddress(poolNum);

    const rpcUrl   = await pickRpc();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet   = new ethers.Wallet(privateKey, provider);

    // Gauge address
    const gaugeHex  = await ethCall(VOTER, VOTER_IFACE.encodeFunctionData('gauges', [POOL]));
    const [gaugeAddr] = ethers.AbiCoder.defaultAbiCoder().decode(['address'], gaugeHex);
    if (!gaugeAddr || gaugeAddr === ethers.ZeroAddress)
      return Response.json({ error: 'Gauge introuvable' }, { status: 500 });
    steps.push(`gauge = ${gaugeAddr}`);

    // AERO earned avant claim
    let earnedBefore = 0n;
    try {
      const earnedHex = await ethCall(gaugeAddr, GAUGE_IFACE.encodeFunctionData('earned', [AERO, tokenId]));
      earnedBefore = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], earnedHex)[0];
    } catch (_) {}
    steps.push(`AERO earned = ${parseFloat(ethers.formatUnits(earnedBefore, 18)).toFixed(4)}`);

    // getReward
    const tx = await wallet.sendTransaction({
      to:   gaugeAddr,
      data: GAUGE_IFACE.encodeFunctionData('getReward', [tokenId]),
    });
    steps.push(`getReward tx envoyée : ${tx.hash}`);

    // Attendre confirmation
    let confirmed = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 2000));
      for (const url of RPC_URLS) {
        try {
          const res  = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [tx.hash] }),
            signal: AbortSignal.timeout(5000),
          });
          const json = await res.json();
          if (json.result) {
            if (json.result.status === '0x0') throw new Error(`revert (hash=${tx.hash})`);
            confirmed = true;
            break;
          }
        } catch (e) {
          if (e.message?.startsWith('revert')) throw e;
        }
      }
      if (confirmed) break;
    }
    if (!confirmed) throw new Error(`timeout confirmation ${tx.hash}`);
    steps.push('getReward confirmée ✓');

    // Solde AERO dans le wallet
    let aeroBal = 0n;
    try {
      const balHex = await ethCall(AERO, ERC20_IFACE.encodeFunctionData('balanceOf', [wallet.address]));
      aeroBal = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], balHex)[0];
    } catch (_) {}
    const aeroAmount = parseFloat(ethers.formatUnits(aeroBal, 18)).toFixed(4);
    steps.push(`AERO wallet = ${aeroAmount}`);

    return Response.json({ ok: true, tokenId: tokenId.toString(), aeroWallet: aeroAmount, txHash: tx.hash, steps });

  } catch (e) {
    return Response.json({ error: e.message ?? String(e), steps }, { status: 500 });
  }
}
