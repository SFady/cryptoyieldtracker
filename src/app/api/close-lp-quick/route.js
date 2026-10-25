import { ethers } from 'ethers';
import { neon }   from '@neondatabase/serverless';
import { getPoolAddress } from '../../lib/config';

export const runtime     = 'nodejs';
export const maxDuration = 60;

const NFPM        = '0x827922686190790b37229fd06084350E74485b72';
const NFPM_NEW    = '0xe1f8cd9ac4e4a65f54f38a5cdafca44f6dd68b53';
const FACTORY_NEW = '0xf8f2eb4940cfe7d13603dddd87f123820fc061ef';
const WETH        = '0x4200000000000000000000000000000000000006';
const VOTER       = '0x16613524e02ad97eDfeF371bC883F2F5d6C480A5';

const RPC_URLS = [
  process.env.ALCHEMY_RPC_URL,
  'https://base.drpc.org',
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
  'https://mainnet.base.org',
].filter(Boolean);

const MAX_UINT128 = (1n << 128n) - 1n;

const ERC20_IFACE = new ethers.Interface([
  'function balanceOf(address) view returns (uint256)',
]);
const NFPM_IFACE = new ethers.Interface([
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)',
]);
const GAUGE_IFACE = new ethers.Interface([
  'function stakedValues(address depositor) view returns (uint256[])',
  'function withdraw(uint256 tokenId)',
  'function getReward(uint256 tokenId)',
]);
const VOTER_IFACE = new ethers.Interface([
  'function gauges(address pool) view returns (address)',
]);
const POOL_IFACE = new ethers.Interface([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
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
  throw new Error(`eth_call(${to}) failed on all RPCs`);
}

async function view(to, iface, fn, args = []) {
  const hex = await ethCall(to, iface.encodeFunctionData(fn, args));
  return iface.decodeFunctionResult(fn, hex);
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

async function sendTx(wallet, params) {
  // Nonce suivi en mémoire sur l'instance wallet (une par requête), pour toute la durée de
  // l'exécution — jamais rerequêté au RPC entre deux envois séquentiels différents (évite une course
  // de propagation entre deux appels sendTx, cf. incident du 02/10 dans closePositions).
  if (wallet._nextNonce == null) {
    wallet._nextNonce = await wallet.provider.getTransactionCount(wallet.address, 'pending');
  }
  let nonce = params.nonce ?? wallet._nextNonce;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const tx = await wallet.sendTransaction({ ...params, nonce });
      wallet._nextNonce = nonce + 1;
      return tx;
    } catch (e) {
      const msg = ((e.shortMessage ?? '') + ' ' + (e.message ?? '')).toLowerCase();
      if (attempt < 2 && /replacement fee too low|replacement transaction underpriced/i.test(msg)) {
        const feeData = await wallet.provider.getFeeData();
        params = {
          ...params,
          maxFeePerGas:         (feeData.maxFeePerGas         ?? 2000000000n) * 125n / 100n,
          maxPriorityFeePerGas: (feeData.maxPriorityFeePerGas ?? 1000000n)   * 125n / 100n,
        };
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      if (attempt < 2 && /nonce too low|nonce has already been used|transaction already imported/i.test(msg)) {
        nonce = await wallet.provider.getTransactionCount(wallet.address, 'pending');
        wallet._nextNonce = nonce;
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      throw e;
    }
  }
}

async function waitForTx(provider, tx) {
  try {
    const r = await tx.wait();
    if (r?.status === 0) throw new Error('reverted');
    return r;
  } catch (_) {
    for (let i = 0; i < 20; i++) {
      await new Promise(res => setTimeout(res, 2000));
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
            return json.result;
          }
        } catch (e) {
          if (e.message?.startsWith('revert')) throw e;
        }
      }
    }
    throw new Error(`timeout confirmation ${tx.hash}`);
  }
}

// POST /api/close-lp-quick
// Ferme la LP (unstake + decreaseLiquidity + collect) sans swap. ~30s.
export async function POST(req) {
  // Désactivé (25/10) — route legacy jamais migrée vers le nouveau protocole Aero (VOTER/NFPM
  // encore ceux d'avant la fusion du 21/10). Plus de risque de perte à laisser une route non
  // auditée pouvoir encore envoyer des transactions réelles.
  return Response.json({ error: "Route désactivée — non migrée vers le nouveau protocole Aero" }, { status: 410 });
}
