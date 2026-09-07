import { ethers } from 'ethers';

export const runtime     = 'nodejs';
export const maxDuration = 60;

// Endpoint one-shot de récupération : force l'enregistrement du stake pour un NFT
// déjà transféré au gauge mais non reconnu par stakedContains() (deposit()/withdraw() bloqués).
// N'agit que sur le tokenId et le gauge fournis explicitement — aucun effet sur le reste du système.

const RPC_URLS = [
  process.env.ALCHEMY_RPC_URL,
  'https://mainnet.base.org',
  'https://base.drpc.org',
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
].filter(Boolean);

const RECEIVER_IFACE = new ethers.Interface([
  'function onERC721Received(address operator, address from, uint256 tokenId, bytes data) returns (bytes4)',
]);

const GAUGE_IFACE = new ethers.Interface([
  'function stakedContains(address depositor, uint256 tokenId) view returns (bool)',
]);

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const { gaugeAddr, tokenId, poolNum } = body;
  if (!gaugeAddr || !tokenId) {
    return Response.json({ error: 'gaugeAddr et tokenId requis' }, { status: 400 });
  }

  const privateKey = poolNum === 3 ? process.env.PRIVATE_KEY_3 : process.env.PRIVATE_KEY;
  if (!privateKey) return Response.json({ error: 'PRIVATE_KEY manquant' }, { status: 500 });

  let provider;
  for (const url of RPC_URLS) {
    try { provider = new ethers.JsonRpcProvider(url); await provider.getBlockNumber(); break; } catch (_) {}
  }
  if (!provider) return Response.json({ error: 'RPC indisponible' }, { status: 503 });

  const wallet = new ethers.Wallet(privateKey.trim(), provider);

  try {
    const beforeHex = await provider.call({
      to: gaugeAddr,
      data: GAUGE_IFACE.encodeFunctionData('stakedContains', [wallet.address, tokenId]),
    });
    const [stakedBefore] = GAUGE_IFACE.decodeFunctionResult('stakedContains', beforeHex);

    const data = RECEIVER_IFACE.encodeFunctionData('onERC721Received', [
      wallet.address, wallet.address, tokenId, '0x',
    ]);
    const tx = await wallet.sendTransaction({ to: gaugeAddr, data, gasLimit: 300000n });
    const receipt = await tx.wait();

    const afterHex = await provider.call({
      to: gaugeAddr,
      data: GAUGE_IFACE.encodeFunctionData('stakedContains', [wallet.address, tokenId]),
    });
    const [stakedAfter] = GAUGE_IFACE.decodeFunctionResult('stakedContains', afterHex);

    return Response.json({
      ok: true,
      txHash: tx.hash,
      status: receipt.status,
      stakedBefore,
      stakedAfter,
    });
  } catch (e) {
    return Response.json({ error: e.shortMessage ?? e.message }, { status: 500 });
  }
}
