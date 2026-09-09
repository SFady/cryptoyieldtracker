import { ethers } from 'ethers';
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
  const r = await tx.wait();
  if (r?.status === 0) throw new Error('reverted');
  return r;
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

    // 4. Approve NFPM -> gauge
    const txApprove = await wallet.sendTransaction({
      to: nfpm, data: NFPM_IFACE.encodeFunctionData('approve', [gaugeAddr, tokenId]),
    });
    await waitForTx(provider, txApprove);

    // 5. Deposit officiel — v1 puis v2
    let depositHash = null;
    let depositErr  = null;
    try {
      const tx = await wallet.sendTransaction({
        to: gaugeAddr, data: GAUGE_IFACE.encodeFunctionData('deposit(uint256)', [tokenId]), gasLimit: 500000n,
      });
      await waitForTx(provider, tx);
      depositHash = tx.hash;
    } catch (e1) {
      try {
        const tx2 = await wallet.sendTransaction({
          to: gaugeAddr, data: GAUGE_IFACE.encodeFunctionData('deposit(uint256,uint256)', [tokenId, 0n]), gasLimit: 500000n,
        });
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
    try {
      const sql = neon(process.env.DATABASE_URL);
      await sql`
        INSERT INTO lp_events (action1, action2, token_id, pool_num, range_min, range_max, created_at)
        VALUES ('CREATE_OK', NULL, ${String(tokenId)}, ${poolNum}, ${rangeMin}, ${rangeMax}, NOW())
      `;
    } catch (_) {}
    await writeLpState(poolNum, {
      action1: 'CREATE_OK', action2: null, token_id: String(tokenId),
      range_min: String(rangeMin), range_max: String(rangeMax),
      created_at: new Date().toISOString(),
    });

    return Response.json({ ok: true, tokenId, gaugeAddr, depositHash, rangeMin, rangeMax });
  } catch (e) {
    return Response.json({ error: e.shortMessage ?? e.message }, { status: 500 });
  }
}
