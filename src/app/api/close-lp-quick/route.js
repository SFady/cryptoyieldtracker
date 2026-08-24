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
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await wallet.sendTransaction(params);
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
        params = { ...params, nonce: await wallet.provider.getTransactionCount(wallet.address, 'pending') };
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
  const body    = await req.json().catch(() => ({}));
  const poolNum = body.poolNum ?? 2;

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) return Response.json({ error: 'PRIVATE_KEY manquant' }, { status: 500 });

  const POOL = getPoolAddress(poolNum);
  const steps = [];

  try {
    const rpcUrl   = await pickRpc();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet   = new ethers.Wallet(privateKey, provider);
    const freshDeadline = () => Math.floor(Date.now() / 1000) + 600;

    // 1. Gauge address
    const [gaugeAddr] = await view(VOTER, VOTER_IFACE, 'gauges', [POOL]);
    if (!gaugeAddr || gaugeAddr === ethers.ZeroAddress)
      return Response.json({ error: 'Gauge introuvable' }, { status: 500 });

    // Détecter NFPM v1 vs v2
    let nfpm = NFPM;
    try {
      const factHex = await ethCall(POOL, '0xc45a0155');
      const [poolFactory] = ethers.AbiCoder.defaultAbiCoder().decode(['address'], factHex);
      if (poolFactory.toLowerCase() === FACTORY_NEW) nfpm = NFPM_NEW;
    } catch (_) {}

    // Stablecoin du pool
    const [poolToken0] = await view(POOL, POOL_IFACE, 'token0');
    const [poolToken1] = await view(POOL, POOL_IFACE, 'token1');
    const stablecoin = poolToken0.toLowerCase() === WETH.toLowerCase() ? poolToken1 : poolToken0;

    // 2. Unstake toutes les positions du gauge
    const unstakedList = [];
    const [stakedIds] = await view(gaugeAddr, GAUGE_IFACE, 'stakedValues', [wallet.address]);
    steps.push(`${stakedIds.length} position(s) stakée(s)`);

    for (const tokenId of stakedIds) {
      // getReward (silencieux)
      try {
        const tx = await sendTx(wallet, {
          to: gaugeAddr,
          data: GAUGE_IFACE.encodeFunctionData('getReward', [tokenId]),
        });
        await waitForTx(provider, tx);
        steps.push(`getReward ${tokenId} ✓`);
      } catch (_) {}

      // withdraw
      const withdrawData = GAUGE_IFACE.encodeFunctionData('withdraw', [tokenId]);
      let withdrawGas = 300000n;
      try { const est = await provider.estimateGas({ to: gaugeAddr, from: wallet.address, data: withdrawData }); withdrawGas = est * 3n / 2n; } catch (_) {}
      const txW = await sendTx(wallet, { to: gaugeAddr, data: withdrawData, gasLimit: withdrawGas });
      await waitForTx(provider, txW);
      unstakedList.push(tokenId.toString());
      steps.push(`withdraw ${tokenId} ✓`);
    }

    // Fallback DB si gauge vide
    if (stakedIds.length === 0) {
      try {
        const sql = neon(process.env.DATABASE_URL);
        const rows = await sql`
          SELECT token_id FROM lp_events
          WHERE action1 IN ('CREATE_OK','CREATE_ERR') AND action2 IS NULL AND token_id IS NOT NULL
            AND COALESCE(pool_num, 2) = ${poolNum}
          ORDER BY id DESC LIMIT 1`;
        if (rows[0]?.token_id) {
          const dbTokenId = BigInt(rows[0].token_id);
          const [owner] = await view(nfpm, NFPM_IFACE, 'ownerOf', [dbTokenId]);
          if (owner.toLowerCase() === wallet.address.toLowerCase()) {
            unstakedList.push(dbTokenId.toString());
            steps.push(`fallback DB tokenId=${dbTokenId} (déjà dans wallet)`);
          }
        }
      } catch (_) {}
    }

    // 3. decreaseLiquidity + collect pour chaque NFT
    const collectedList = [];
    const tokenIdSet = new Set(unstakedList.map(BigInt));

    // Aussi scanner le wallet
    try {
      const [count] = await view(nfpm, NFPM_IFACE, 'balanceOf', [wallet.address]);
      for (let i = 0n; i < count; i++) {
        try {
          const [tid] = await view(nfpm, NFPM_IFACE, 'tokenOfOwnerByIndex', [wallet.address, i]);
          tokenIdSet.add(tid);
        } catch (_) { break; }
      }
    } catch (_) {}

    for (const tokenId of tokenIdSet) {
      let pos;
      try { pos = await view(nfpm, NFPM_IFACE, 'positions', [tokenId]); } catch (_) { continue; }

      // Filtrer par pool
      if (
        pos.token0.toLowerCase() !== WETH.toLowerCase() ||
        pos.token1.toLowerCase() !== stablecoin.toLowerCase()
      ) continue;

      if (pos.liquidity === 0n && pos.tokensOwed0 === 0n && pos.tokensOwed1 === 0n) continue;

      // decreaseLiquidity
      if (pos.liquidity > 0n) {
        const dlParams = { tokenId, liquidity: pos.liquidity, amount0Min: 0n, amount1Min: 0n, deadline: freshDeadline() };
        let gasLimit = 400000n;
        try { const est = await provider.estimateGas({ to: nfpm, from: wallet.address, data: NFPM_IFACE.encodeFunctionData('decreaseLiquidity', [dlParams]) }); gasLimit = est * 3n / 2n; } catch (_) {}
        const txDL = await sendTx(wallet, { to: nfpm, data: NFPM_IFACE.encodeFunctionData('decreaseLiquidity', [dlParams]), gasLimit });
        await waitForTx(provider, txDL);
        steps.push(`decreaseLiquidity ${tokenId} ✓`);
      }

      // collect
      const collectData = NFPM_IFACE.encodeFunctionData('collect', [{ tokenId, recipient: wallet.address, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }]);
      let collectGas = 400000n;
      try { const est = await provider.estimateGas({ to: nfpm, from: wallet.address, data: collectData }); collectGas = est * 3n / 2n; } catch (_) {}
      const txC = await sendTx(wallet, { to: nfpm, data: collectData, gasLimit: collectGas });
      await waitForTx(provider, txC);
      collectedList.push(tokenId.toString());
      steps.push(`collect ${tokenId} ✓`);
    }

    // 4. Lire les soldes finaux
    const readBal = async (token) => {
      try {
        const h = await ethCall(token, ERC20_IFACE.encodeFunctionData('balanceOf', [wallet.address]));
        return ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], h)[0];
      } catch (_) { return 0n; }
    };
    const stableBal = await readBal(stablecoin);
    const wethBal   = await readBal(WETH);
    const finalUsdc = parseFloat(ethers.formatUnits(stableBal, 6)).toFixed(2);
    const finalWeth = parseFloat(ethers.formatUnits(wethBal, 18)).toFixed(4);

    // 5. Marquer CLOSE_OK en DB
    if (collectedList.length > 0) {
      try {
        const sql = neon(process.env.DATABASE_URL);
        for (const tokenId of collectedList) {
          await sql`UPDATE lp_events SET action2 = 'CLOSE_OK', closed_at = NOW() WHERE token_id = ${tokenId} AND action1 = 'CREATE_OK'`;
        }
      } catch (_) {}
    }

    return Response.json({ ok: true, unstaked: unstakedList, collected: collectedList, finalUsdc, finalWeth, steps });

  } catch (e) {
    return Response.json({ error: e.message ?? String(e), steps }, { status: 500 });
  }
}
