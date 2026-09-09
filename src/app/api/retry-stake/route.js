import { ethers } from 'ethers';
import { kv } from '@vercel/kv';
import { neon } from '@neondatabase/serverless';
import { writeLpState } from '../../lib/cronKv';
import { getPoolAddress } from '../../lib/config';

export const runtime     = 'nodejs';
export const maxDuration = 120;

// Retente le staking (deposit officiel) d'un NFT de position déjà miné mais resté
// non-staké dans le wallet (ex: setApprovalForAll/deposit a échoué au moment de la
// création). N'utilise QUE les fonctions officielles du gauge (approve + deposit) —
// jamais de transfert direct. Si le wallet n'est pas propriétaire du NFT, on refuse.

const NFPM_NEW    = '0xe1f8cd9ac4e4a65f54f38a5cdafca44f6dd68b53';
const NFPM_OLD    = '0x827922686190790b37229fd06084350E74485b72';
const VOTER       = '0x16613524e02ad97eDfeF371bC883F2F5d6C480A5';
const DECIMAL_ADJUSTMENT = 6 - 18;

const RPC_URLS = [
  process.env.ALCHEMY_RPC_URL,
  'https://mainnet.base.org',
  'https://base.drpc.org',
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
].filter(Boolean);

const NFPM_IFACE = new ethers.Interface([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function approve(address to, uint256 tokenId)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
]);
const VOTER_IFACE = new ethers.Interface(['function gauges(address pool) view returns (address)']);
const GAUGE_IFACE = new ethers.Interface([
  'function deposit(uint256 tokenId)',
  'function deposit(uint256 tokenId, uint256 tokenVeloPair)',
]);

function tickToPrice(tick) {
  return Math.pow(1.0001, tick) * Math.pow(10, -DECIMAL_ADJUSTMENT);
}

async function waitForTx(provider, tx) {
  try {
    const r = await tx.wait();
    if (r?.status === 0) throw new Error('reverted');
    return r;
  } catch (_) {
    // tx.wait() peut échouer sur un RPC flaky même si la tx a réussi — repoller le reçu directement
    for (let i = 0; i < 30; i++) {
      await new Promise(res => setTimeout(res, 2000));
      for (const url of RPC_URLS) {
        try {
          const res = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [tx.hash] }),
          });
          const json = await res.json();
          if (json.result) {
            if (json.result.status === '0x0') throw new Error('reverted');
            return json.result;
          }
        } catch (e) { if (e.message === 'reverted') throw e; }
      }
    }
    throw new Error('confirmation timeout');
  }
}

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const { tokenId, poolNum = 2 } = body;
  if (!tokenId) return Response.json({ error: 'tokenId requis' }, { status: 400 });

  const privateKey = poolNum === 3 ? process.env.PRIVATE_KEY_3 : process.env.PRIVATE_KEY;
  if (!privateKey) return Response.json({ error: `PRIVATE_KEY${poolNum === 3 ? '_3' : ''} manquant` }, { status: 500 });

  let provider;
  for (const url of RPC_URLS) {
    try { provider = new ethers.JsonRpcProvider(url); await provider.getBlockNumber(); break; } catch (_) {}
  }
  if (!provider) return Response.json({ error: 'RPC indisponible' }, { status: 503 });

  const wallet = new ethers.Wallet(privateKey.trim(), provider);

  // Le NFT peut être sur l'ancien ou le nouveau NFPM selon l'historique du pool
  let nfpm = NFPM_NEW;
  try {
    const owner = await provider.call({ to: NFPM_NEW, data: NFPM_IFACE.encodeFunctionData('ownerOf', [tokenId]) });
    if (!owner || owner === '0x') throw new Error('empty');
  } catch (_) {
    nfpm = NFPM_OLD;
  }

  try {
    // 1. Vérifier que le wallet possède bien ce NFT
    const ownerHex = await provider.call({ to: nfpm, data: NFPM_IFACE.encodeFunctionData('ownerOf', [tokenId]) });
    const ownerAddr = '0x' + ownerHex.slice(-40);
    if (ownerAddr.toLowerCase() !== wallet.address.toLowerCase()) {
      return Response.json({ error: `Le wallet ne possède pas ce NFT (owner actuel: ${ownerAddr})` }, { status: 400 });
    }

    // 2. Lire le range de la position (pour reconstruire lpState)
    const posHex = await provider.call({ to: nfpm, data: NFPM_IFACE.encodeFunctionData('positions', [tokenId]) });
    const pos    = NFPM_IFACE.decodeFunctionResult('positions', posHex);
    const rangeMin = tickToPrice(Number(pos.tickLower));
    const rangeMax = tickToPrice(Number(pos.tickUpper));

    // 3. Trouver le gauge du pool
    const poolAddr   = getPoolAddress(poolNum);
    const gaugeHex   = await provider.call({ to: VOTER, data: VOTER_IFACE.encodeFunctionData('gauges', [poolAddr]) });
    const [gaugeAddr] = ethers.AbiCoder.defaultAbiCoder().decode(['address'], gaugeHex);
    if (!gaugeAddr || gaugeAddr === ethers.ZeroAddress) {
      return Response.json({ error: 'Gauge introuvable pour ce pool' }, { status: 500 });
    }

    // 3b. Calculer la valeur réelle de la position (prix courant du pool + liquidité)
    //     pour que le capital d'ouverture affiché reflète la réalité, pas une ancienne position.
    //     Tout en unités brutes on-chain (ticks/liquidity) pour éviter les erreurs de décimales,
    //     conversion en $ seulement à la toute fin.
    let openingTotal = null;
    try {
      const slot0Hex   = await provider.call({ to: poolAddr, data: '0x3850c7bd' });
      const sqrtX96    = ethers.AbiCoder.defaultAbiCoder().decode(['uint160'], slot0Hex)[0];
      const sqrtP_raw  = Number(sqrtX96) / Number(2 ** 96);
      const poolPrice  = sqrtP_raw * sqrtP_raw * 1e12; // prix humain $/WETH, pour la conversion finale uniquement

      const L          = Number(pos.liquidity);
      const sqrtPa_raw = Math.pow(1.0001, Number(pos.tickLower) / 2);
      const sqrtPb_raw = Math.pow(1.0001, Number(pos.tickUpper) / 2);
      const sqrtPc_raw = Math.min(Math.max(sqrtP_raw, sqrtPa_raw), sqrtPb_raw);

      const wethAmount = (L * (1 / sqrtPc_raw - 1 / sqrtPb_raw)) / 1e18;
      const usdcAmount = (L * (sqrtPc_raw - sqrtPa_raw)) / 1e6;
      openingTotal = parseFloat((wethAmount * poolPrice + usdcAmount).toFixed(2));
    } catch (_) {}

    // 4. Approve NFPM -> gauge
    const txApprove = await wallet.sendTransaction({
      to: nfpm, data: NFPM_IFACE.encodeFunctionData('approve', [gaugeAddr, tokenId]),
    });
    await waitForTx(provider, txApprove);

    // 5. Deposit officiel — v1 puis v2, avec estimation de gas réelle (fallback 500k si l'estimation échoue)
    let depositHash = null;
    let depositErr  = null;
    try {
      const data = GAUGE_IFACE.encodeFunctionData('deposit(uint256)', [tokenId]);
      let gasLimit = 500000n;
      try {
        const est = await provider.estimateGas({ to: gaugeAddr, from: wallet.address, data });
        gasLimit = est * 3n / 2n;
      } catch (_) {}
      const tx = await wallet.sendTransaction({ to: gaugeAddr, data, gasLimit });
      await waitForTx(provider, tx);
      depositHash = tx.hash;
    } catch (e1) {
      try {
        const data2 = GAUGE_IFACE.encodeFunctionData('deposit(uint256,uint256)', [tokenId, 0n]);
        let gasLimit2 = 500000n;
        try {
          const est2 = await provider.estimateGas({ to: gaugeAddr, from: wallet.address, data: data2 });
          gasLimit2 = est2 * 3n / 2n;
        } catch (_) {}
        const tx2 = await wallet.sendTransaction({ to: gaugeAddr, data: data2, gasLimit: gasLimit2 });
        await waitForTx(provider, tx2);
        depositHash = tx2.hash;
      } catch (e2) {
        depositErr = `v1: ${e1.shortMessage ?? e1.message} | v2: ${e2.shortMessage ?? e2.message}`;
      }
    }

    if (!depositHash) {
      return Response.json({ error: `deposit() échoué : ${depositErr}` }, { status: 500 });
    }

    // 6. Mettre à jour DB + Redis pour que le bot reconnaisse la position comme active
    //    (y compris le capital d'ouverture, pour que l'affichage ne reste pas bloqué sur l'ancienne position)
    try {
      const sql = neon(process.env.DATABASE_URL);
      await sql`
        INSERT INTO lp_events (action1, action2, token_id, pool_num, range_min, range_max, total_at_open, created_at)
        VALUES ('CREATE_OK', NULL, ${String(tokenId)}, ${poolNum}, ${rangeMin}, ${rangeMax}, ${openingTotal}, NOW())
      `;
    } catch (_) {}
    await writeLpState(poolNum, {
      action1: 'CREATE_OK', action2: null, token_id: String(tokenId),
      range_min: String(rangeMin), range_max: String(rangeMax),
      created_at: new Date().toISOString(),
    });
    if (openingTotal !== null) {
      try {
        await kv.set(`p${poolNum}_opening_total`, openingTotal, { ex: 30 * 86400 });
        await kv.set(`p${poolNum}_opening_lp`,    openingTotal, { ex: 30 * 86400 });
      } catch (_) {}
    }

    return Response.json({ ok: true, tokenId, gaugeAddr, depositHash, rangeMin, rangeMax, openingTotal });
  } catch (e) {
    return Response.json({ error: e.shortMessage ?? e.message }, { status: 500 });
  }
}
