import { ethers } from 'ethers';
import { NFPM_ADDRESS as NFPM } from '../../lib/config.js';

export const runtime     = 'nodejs';
export const maxDuration = 30;

const WALLET = '0xac383af8f62a73a6b156ffa86eb2820bd6a3a2f6';
const POOL   = '0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59';
const RPC_URLS = [
  'https://base.drpc.org',
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
  'https://mainnet.base.org',
];

const M256 = 1n << 256n;
function pad64(n) { return (((BigInt(n) % M256) + M256) % M256).toString(16).padStart(64, '0'); }
function word(h, i) { const s = h.startsWith('0x') ? h.slice(2) : h; return s.slice(i * 64, (i + 1) * 64); }
function toUint(w) { if (!w || w === '0x') return 0n; const s = w.startsWith('0x') ? w.slice(2) : w; return s ? BigInt('0x' + s) : 0n; }
function toInt(w)  { const n = toUint(w); return n >= M256 / 2n ? n - M256 : n; }

const walletPad = WALLET.slice(2).toLowerCase().padStart(64, '0');

export async function GET() {
  let ethCall;
  for (const url of RPC_URLS) {
    try {
      const test = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
        signal: AbortSignal.timeout(4000),
      });
      const j = await test.json();
      if (j.result) {
        ethCall = async (to, data) => {
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
            signal: AbortSignal.timeout(8000),
          });
          return (await r.json()).result;
        };
        break;
      }
    } catch (_) {}
  }
  if (!ethCall) return Response.json({ error: 'RPC indisponible' }, { status: 503 });

  // 1. Lire les tokenIds spécifiques à vérifier + scan wallet
  const tokenIdsToCheck = [4952130n, 4952274n];

  // 2. Scan wallet NFTs
  try {
    const countHex = await ethCall(NFPM, '0x70a08231' + walletPad);
    const count = Number(toUint(countHex));
    if (count > 0) {
      const walletIds = await Promise.all(
        Array.from({ length: count }, (_, i) =>
          ethCall(NFPM, '0x2f745c59' + walletPad + pad64(i)).then(toUint)
        )
      );
      for (const id of walletIds) {
        if (!tokenIdsToCheck.includes(id)) tokenIdsToCheck.push(id);
      }
    }
  } catch (_) {}

  // 3. Lire slot0 pour le prix ETH
  let ethPrice = 0;
  try {
    const s0 = await ethCall(POOL, '0x3850c7bd');
    const sqrtP = toUint(word(s0, 0));
    ethPrice = Number((sqrtP * sqrtP * 10n ** 12n) / (1n << 192n));
  } catch (_) {}

  // 4. Lire chaque position
  const positions = await Promise.all(tokenIdsToCheck.map(async (id) => {
    try {
      const h = await ethCall(NFPM, '0x99fbab88' + pad64(id));
      const tickLower  = Number(toInt(word(h, 5)));
      const tickUpper  = Number(toInt(word(h, 6)));
      const liquidity  = toUint(word(h, 7));
      const owed0      = toUint(word(h, 10));
      const owed1      = toUint(word(h, 11));
      const priceLow   = (1.0001 ** tickLower * 1e12).toFixed(0);
      const priceHigh  = (1.0001 ** tickUpper * 1e12).toFixed(0);
      const active     = liquidity > 0n || owed0 > 0n || owed1 > 0n;
      return {
        tokenId:   id.toString(),
        liquidity: liquidity.toString(),
        active,
        priceLow,
        priceHigh,
        owed0:     (Number(owed0) / 1e18).toFixed(6),
        owed1:     (Number(owed1) / 1e6).toFixed(2),
      };
    } catch (e) {
      return { tokenId: id.toString(), error: e.message };
    }
  }));

  return Response.json({ ethPrice, positions, walletNFTCount: tokenIdsToCheck.length });
}
