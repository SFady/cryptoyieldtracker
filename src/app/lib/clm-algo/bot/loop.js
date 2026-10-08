import { ethers }           from 'ethers';
import { kv }               from '@vercel/kv';
import { neon }             from '@neondatabase/serverless';
import { ALGO_CONFIG, REDIS_KEYS } from '../config.js';
import { readLpState, writeLpState, readP2Range, writeP2Range, getPercentileRange, getPriceAverage14d, getPriceAverage24h, getLastNPrices, writeAeroSentToday, readRule1K, writeRule1K } from '../../cronKv.js';
import { NFPM_ADDRESS, POOL_ADDRESS_2 } from '../../config.js';
import { logBotTick }       from './metrics.js';

// Les routes internes (closePositions, createPosition, collectFees, claimAero, swap-weth-usdc)
// exigent désormais une authentification (05/10 — elles étaient appelables par n'importe qui,
// sans protection). Le bot s'authentifie en relayant CRON_SECRET, le même secret que cron/route.js
// utilise déjà pour vérifier ses propres déclenchements — voir lib/apiAuth.js.
function authHeaders() {
  const secret = process.env.CRON_SECRET;
  return secret ? { Authorization: `Bearer ${secret}` } : {};
}

async function sendErrorEmail(subject, body) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body:    JSON.stringify({
        from:    'onboarding@resend.dev',
        to:      'sylvain.fady@gmail.com',
        subject,
        html:    `<pre style="font-family:monospace">${body}</pre>`,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (_) {}
}

// Module 7 — Orchestrateur cron pool 2
// BOT_ENABLED = true — seules les Règles 1 à 5 ci-dessous sont actives.
// Règles (05/10, refonte complète — abandon du système de triggers de prix/K dynamique au profit
// d'un déclenchement direct sur le ratio WETH de la position) :
//   1.  Aucune position → ouverture en gardant les proportions WETH/USDC déjà présentes dans le
//       wallet (le range se place de façon asymétrique pour matcher ce qui est déjà détenu),
//       plafonnées à 70/30 des deux côtés (swap partiel si le wallet dépasse cette fourchette) —
//       évite un centre de range collé à un bord, fragile face au prix pendant le mint (05/10).
//       Largeur = percentile24h brut (×1). K remis à 1.
//   2.  Trigger bas : ratio WETH de la position ≥ 95% (prix proche du bas du range) → collecte AERO
//       (25% envoyé/75% gardé), ferme et rouvre à 75% WETH (swap forcé), largeur = percentile24h ×
//       1,25. K remis à 1.
//   3.  Trigger haut : ratio WETH de la position ≤ 5% (prix proche du haut du range) → collecte AERO
//       (50% envoyé/50% gardé), ferme et rouvre à 25% WETH (swap forcé), largeur = percentile24h
//       brut (×1). K remis à 1.
//   4.  Si aucun envoi vers le wallet externe n'a eu lieu depuis 24h glissantes, réclame l'AERO
//       accumulé sans fermer la LP et en envoie 25% (75% restent en solde non utilisé).
//   5.  Range devenu trop large : percentile24h tombé à au moins 1pt sous la largeur actuelle →
//       resserre directement à percentile24h, SANS swap (garde les proportions WETH/USDC actuelles).
//       K remis à 1. (07/10 — remplace l'ancien garde-fou de largeur, supprimé le 05/10, avec un
//       déclencheur plus simple : écart direct au percentile, pas de comparaison ×2.)
//   Règles 2/3 confirmées sur 5 ticks consécutifs (même compteur/dots que l'ancien système,
//   p2_oor_count/p2_oor_low) avant de rebalancer — évite de réagir à un ratio qui ne fait que
//   passer la frontière un instant. Règle 5 vérifiée à chaque tick sans confirmation (le percentile24h
//   est déjà une moyenne glissante sur 24h, peu sujette au bruit instantané).
//   Supprimé dans cette refonte : les triggers de prix stockés (low/high trigger, p2_live_range),
//   le paramètre K dynamique (doublement/division/coupe-circuit), la Règle 1d (changement de
//   tendance), le claim matinal 7h Paris. K reste persisté (p2_rule1_k, Redis + repli table
//   bot_config) et affiché sur la page pools, mais chaque règle le remet simplement à 1 — il ne
//   pilote plus aucune formule.
//   Réouvertures (Règles 1/2/3) : spread check (1,5% sur 20 derniers prix) avant de rouvrir — si le
//   marché est trop agité, la réouverture est sautée, la Règle 1 la reprendra au tick suivant.

// Coupe-circuit global : si false, botLoop() ne fait plus rien du tout — la position ouverte reste
// telle quelle, en attente. Le code de chaque règle reste intact, prêt à repartir en repassant ce
// flag à true.
const BOT_ENABLED = true;

// Lettre de tendance vs une moyenne mobile : H (haussier, prix ≥ MM) ou B (baissier, prix < MM) — binaire,
// pas de zone neutre. Utilisé uniquement par autoStart() pour le code "open_trend" affiché (colonne
// Tendance de la page Résultats) — pas par une règle de décision.
function trendLetter(price, avg) {
  if (!price || avg == null) return 'B';
  return price >= avg ? 'H' : 'B';
}

const USDC_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
const ERC20_IFACE  = new ethers.Interface(['function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)']);
const WETH_IFACE   = new ethers.Interface(['function withdraw(uint256)']);
const V2_SWAP_IFACE = new ethers.Interface(['function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)']);
const RPC_URLS = [
  process.env.ALCHEMY_RPC_URL,
  'https://base.drpc.org',
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
  'https://mainnet.base.org',
].filter(Boolean);

// pinnedUrl : force la même source RPC pour des lectures avant/après censées être
// comparables (sinon deux nœuds légèrement désynchronisés faussent la différence).
async function readWalletToken(tokenAddress, decimals, pinnedUrl = null) {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) return 0;
  const wallet = new ethers.Wallet(privateKey.trim());
  const iface  = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
  const data   = iface.encodeFunctionData('balanceOf', [wallet.address]);
  for (const url of (pinnedUrl ? [pinnedUrl] : RPC_URLS)) {
    try {
      const res  = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: tokenAddress, data }, 'latest'] }),
        signal:  AbortSignal.timeout(6000),
      });
      const json = await res.json();
      if (json.result && json.result !== '0x') {
        const raw = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], json.result)[0];
        return Number(raw) / Math.pow(10, decimals);
      }
    } catch (_) {}
  }
  return 0;
}

const getWalletUsdc = (pinnedUrl) => readWalletToken(USDC_ADDRESS, 6, pinnedUrl);
const getWalletWeth = (pinnedUrl) => readWalletToken(WETH_ADDRESS, 18, pinnedUrl);

// ── Valorisation directe de la position (Règle 4) sans passer par /api/positions2 ─────────
// Mêmes adresses/formules que positions2 et claimAero, dupliquées ici pour que le bot puisse
// calculer sa part WETH et ses revenus totaux à partir de Redis + RPC uniquement, sans toucher Neon.
const VOTER      = '0x16613524e02ad97eDfeF371bC883F2F5d6C480A5';
const AERO       = '0x940181a94A35A4569E4529A3CDfB74e38FD98631';
const V2_ROUTER  = '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43';
const V2_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
const VOTER_IFACE       = new ethers.Interface(['function gauges(address pool) view returns (address)']);
const GAUGE_EARNED_IFACE = new ethers.Interface(['function earned(address account, uint256 tokenId) view returns (uint256)']);
const V2_ROUTER_IFACE   = new ethers.Interface(['function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)']);

async function ethCall(to, data) {
  for (const url of RPC_URLS) {
    try {
      const res  = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
        signal: AbortSignal.timeout(6000),
      });
      const json = await res.json();
      if (json.result && json.result !== '0x') return json.result;
    } catch (_) {}
  }
  throw new Error(`eth_call(${to}) échoué sur tous les RPCs`);
}

async function getAeroUsdValue(tokenId) {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey || !tokenId) return 0;
  const wallet = new ethers.Wallet(privateKey.trim());
  const gaugeHex   = await ethCall(VOTER, VOTER_IFACE.encodeFunctionData('gauges', [POOL_ADDRESS_2]));
  const [gaugeAddr] = VOTER_IFACE.decodeFunctionResult('gauges', gaugeHex);
  if (!gaugeAddr || gaugeAddr === ethers.ZeroAddress) return 0;
  const earnedHex = await ethCall(gaugeAddr, GAUGE_EARNED_IFACE.encodeFunctionData('earned', [wallet.address, BigInt(tokenId)]));
  const [earned]  = GAUGE_EARNED_IFACE.decodeFunctionResult('earned', earnedHex);
  const aeroAmt   = Number(earned) / 1e18;
  if (aeroAmt <= 0) return 0;
  const routes    = [{ from: AERO, to: USDC_ADDRESS, stable: false, factory: V2_FACTORY }];
  const amtsHex   = await ethCall(V2_ROUTER, V2_ROUTER_IFACE.encodeFunctionData('getAmountsOut', [ethers.parseUnits('1', 18), routes]));
  const [amounts] = V2_ROUTER_IFACE.decodeFunctionResult('getAmountsOut', amtsHex);
  const aeroPrice = parseFloat(ethers.formatUnits(amounts[1], 6));
  return aeroAmt * aeroPrice;
}


// Swap une partie de l'USDC gardé (part non envoyée au wallet externe) vers WETH puis unwrap en
// ETH natif (WETH.withdraw) — alimente le gas du wallet. Non-bloquant : un échec ici ne doit jamais
// faire échouer sendAeroSplit (l'envoi externe reste prioritaire).
async function topUpGasFromUsdc(usdcAmount) {
  // Désactivé (03/10) : sur de petits montants, le gas des 3 tx (approve+swap+unwrap) dépassait
  // l'ETH obtenu — effet inverse de celui voulu. À réactiver avec un seuil minimum sûr.
  return { skipped: 'disabled', usdcAmount };
  /* istanbul ignore next */
  if (!usdcAmount || usdcAmount < 0.01) return { skipped: 'insufficient', usdcAmount };
  const amountIn = ethers.parseUnits(usdcAmount.toFixed(6), 6);
  const routes = [{ from: USDC_ADDRESS, to: WETH_ADDRESS, stable: false, factory: V2_FACTORY }];
  const deadline = Math.floor(Date.now() / 1000) + 600;
  for (const url of RPC_URLS) {
    try {
      const provider = new ethers.JsonRpcProvider(url);
      const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY.trim(), provider);

      const txApp = await wallet.sendTransaction({
        to: USDC_ADDRESS,
        data: ERC20_IFACE.encodeFunctionData('approve', [V2_ROUTER, ethers.MaxUint256]),
      });
      await txApp.wait();

      let minOut = 0n;
      try {
        const outHex = await ethCall(V2_ROUTER, V2_ROUTER_IFACE.encodeFunctionData('getAmountsOut', [amountIn, routes]));
        const [amounts] = V2_ROUTER_IFACE.decodeFunctionResult('getAmountsOut', outHex);
        minOut = amounts[amounts.length - 1] * 970n / 1000n; // 3% de slippage toléré
      } catch (_) {}

      // Delta avant/après (pas le solde WETH total) : le wallet peut déjà détenir du WETH utilisé
      // ailleurs (comptabilité de la position) — on n'unwrap que ce que CE swap vient de produire.
      const wethBefore = await readWalletToken(WETH_ADDRESS, 18, url);
      const txSwap = await wallet.sendTransaction({
        to:   V2_ROUTER,
        data: V2_SWAP_IFACE.encodeFunctionData('swapExactTokensForTokens', [amountIn, minOut, routes, wallet.address, deadline]),
      });
      await txSwap.wait();
      const wethAfter = await readWalletToken(WETH_ADDRESS, 18, url);
      const wethReceived = Math.max(0, wethAfter - wethBefore);
      if (wethReceived <= 0) return { error: 'no_weth_received', usdcAmount };
      const wethReceivedRaw = ethers.parseUnits(wethReceived.toFixed(18), 18);

      const txUnwrap = await wallet.sendTransaction({
        to:   WETH_ADDRESS,
        data: WETH_IFACE.encodeFunctionData('withdraw', [wethReceivedRaw]),
      });
      await txUnwrap.wait();

      return { ok: true, usdcSpent: usdcAmount, ethReceived: parseFloat(ethers.formatUnits(wethReceivedRaw, 18)), swapHash: txSwap.hash, unwrapHash: txUnwrap.hash };
    } catch (e) {
      if (url === RPC_URLS[RPC_URLS.length - 1]) return { error: e.message ?? String(e), usdcAmount };
    }
  }
  return { error: 'all_rpcs_failed', usdcAmount };
}

// Verse une fraction des AERO déjà convertis en USDC vers DESTINATION_WALLET.
// Règle 1A (sortie directionnelle) : haut → 50% envoyés/50% gardés ; bas → 25%/75%.
// Règle 1c (resserrement/élargissement, pas de direction) : toujours 25%/75% (isLow=true).
// Gas (03/10) : 2% du TOTAL collecté est prélevé sur la part GARDÉE (pas sur la part envoyée au
// wallet externe, qui reste exactement fraction×total) et converti en ETH natif pour le gas.
// sourceOverride : étiquette explicite pour dest_transfers/transferHistory, au lieu du libellé
// générique edge_low_25pct/edge_high_50pct déduit de isLow — pour bien distinguer dans "envois" un
// cas qui emprunte le même split (25/75) qu'une Règle 2 mais qui n'en est pas une (ex. garde-fou
// largeur du 03/10, qui utilise isLow=true pour le split mais doit s'afficher à part).
async function sendAeroSplit(feesCollectedUsdc, isLow, sourceOverride = null) {
  if (!feesCollectedUsdc || feesCollectedUsdc < 0.01) return { skipped: 'insufficient', feesCollectedUsdc };

  const fraction = isLow ? 0.25 : 0.5;
  const toSend   = parseFloat((feesCollectedUsdc * fraction).toFixed(6));
  const dest     = process.env.DESTINATION_WALLET;
  if (!dest) return { skipped: 'no_dest_wallet' };

  let txHash = null;
  const amount = ethers.parseUnits(String(toSend), 6);
  for (const url of RPC_URLS) {
    try {
      const provider = new ethers.JsonRpcProvider(url);
      const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY.trim(), provider);
      const tx       = await wallet.sendTransaction({
        to:   USDC_ADDRESS,
        data: ERC20_IFACE.encodeFunctionData('transfer', [dest, amount]),
      });
      await tx.wait();
      txHash = tx.hash;
      break;
    } catch (_) {}
  }
  if (!txHash) return { error: 'transfer_failed', toSend };

  try {
    const sqlDb = neon(process.env.DATABASE_URL);
    await sqlDb`INSERT INTO dest_transfers (amount_usdc, source, tx_hash, pool_num)
                VALUES (${toSend}, ${sourceOverride ?? (isLow ? 'edge_low_25pct' : 'edge_high_50pct')}, ${txHash}, ${2})`;
  } catch (_) {}
  await writeAeroSentToday(2).catch(() => {});
  // Compte aussi comme un envoi externe pour la Règle 5 (claim périodique 24h) — évite un envoi
  // redondant peu après si une sortie de zone vient déjà d'en déclencher un.
  await kv.set('p2_last_aero_send_at', Date.now(), { ex: 30 * 86400 }).catch(() => {});

  // 2% du total collecté, prélevé sur la part gardée (jamais sur `toSend`), converti en ETH natif
  // pour le gas. Best-effort : un échec ici n'affecte ni le transfert externe (déjà fait) ni le
  // résultat global de sendAeroSplit (toujours ok:true si on arrive jusqu'ici).
  const gasUsdc = parseFloat((feesCollectedUsdc * 0.02).toFixed(6));
  let gasTopUp = null;
  try { gasTopUp = await topUpGasFromUsdc(gasUsdc); } catch (e) { gasTopUp = { error: e.message ?? String(e), usdcAmount: gasUsdc }; }
  const keptMinusGas = feesCollectedUsdc - toSend - (gasTopUp?.ok ? gasUsdc : 0);

  return { ok: true, sent: toSend, kept: parseFloat(keptMinusGas.toFixed(6)), txHash, side: isLow ? 'low' : 'high', fraction, gasTopUp };
}

// Persiste systématiquement le résultat du split AERO en base (lp_events, pas de TTL — contrairement
// au log Redis p2_algo_metrics qui expire au bout de 7 jours) et alerte par email en cas d'échec
// anormal (claim/swap AERO cassé côté collectFees, RPC down, wallet dest mal configuré) — pour
// éviter de reproduire l'incident du 22/09 (rebalance à 5h15, AERO non transféré, aucune trace
// exploitable après coup).
async function logAndAlertAeroSplit(out, feesCollected) {
  try {
    const sqlDb = neon(process.env.DATABASE_URL);
    const detail = JSON.stringify({
      feesCollected,
      aeroBalance:   out.step2?.aeroBalance ?? null,
      aeroSwapError: out.step2?.aeroSwapError ?? null,
      aeroSplit:     out.aeroSplit,
    });
    await sqlDb`INSERT INTO lp_events (action1, action2, error_msg, pool_num)
                VALUES ('AERO_SPLIT', ${out.aeroSplit?.ok ? 'OK' : 'ISSUE'}, ${detail}, ${2})`;
  } catch (_) {}

  if (!out.aeroSplit?.ok) {
    const isRealFailure = !!out.step2?.aeroSwapError
      || out.aeroSplit?.error === 'transfer_failed'
      || out.aeroSplit?.skipped === 'no_dest_wallet';
    if (isRealFailure) {
      await sendErrorEmail(
        '[CryptoYieldTracker] AERO non transféré — sendAeroSplit',
        `feesCollected: ${feesCollected}\naeroBalance (step2): ${out.step2?.aeroBalance ?? 'n/a'}\naeroSwapError: ${out.step2?.aeroSwapError ?? 'n/a'}\naeroSplit: ${JSON.stringify(out.aeroSplit)}`,
      );
    }
  }
}

async function closeLP(base, keepWeth = true, closeReason = null, feesUsdc = null, aeroSplitFraction = null) {
  const res = await fetch(`${base}/api/closePositions`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body:    JSON.stringify({ keepWeth, poolNum: ALGO_CONFIG.POOL_NUM, caseNum: 9, noTransfer: true, closeReason, feesUsdc, aeroSplitFraction }),
    signal:  AbortSignal.timeout(120000),
  });
  return res.json();
}

// Snapshot partagé (part WETH + total revenus/AERO) pour les vérifications non urgentes (Règle 4 ;
// revenueGate alimente aussi l'ancienne Règle 1c, désactivée) — rafraîchi au maximum une fois toutes
// les ~20 minutes (au lieu d'à chaque tick, soit
// toutes les 5 min). Calculé directement depuis Redis + RPC (liquidityL stocké par autoStart,
// wallet balances, AERO earned du gauge) — sans passer par /api/positions2 ni par Neon, tant que le
// nécessaire est disponible en Redis. Sinon (ex. position recréée via retry-stake, qui n'écrit pas
// liquidityL), repli sur l'ancienne méthode (positions2, qui elle touche Neon).
// Contexte : un compute Neon sollicité au moins une fois toutes les 5 min ne se rendort jamais
// (quota d'heures de calcul du plan free explosé le 26/09) ; les sorties de zone (Règles 2/3,
// détection du prix hors range) restent lues depuis Redis à chaque tick, sans changement — seules
// ces vérifications secondaires tolèrent une donnée vieille de quelques minutes.
async function getGateSnapshotDirect(lpState, rtConfig, rMin, rMax, price) {
  const tokenId = lpState?.token_id;
  const L       = rtConfig?.liquidityL;
  if (!tokenId || !L || isNaN(rMin) || isNaN(rMax) || !price) return null;

  const sqrtPa = Math.sqrt(rMin);
  const sqrtPb = Math.sqrt(rMax);
  const sqrtPc = Math.sqrt(Math.min(Math.max(price, rMin), rMax));
  const wethPoolUsd = L * (1 / sqrtPc - 1 / sqrtPb) * price;
  const usdcPoolUsd = L * (sqrtPc - sqrtPa);

  const [wethWalletUsdRaw, usdcWalletUsd, totalAeros] = await Promise.all([
    getWalletWeth(), getWalletUsdc(), getAeroUsdValue(tokenId).catch(() => 0),
  ]);
  const wethWalletUsd = wethWalletUsdRaw * price;
  const totalUsd      = wethPoolUsd + usdcPoolUsd + wethWalletUsd + usdcWalletUsd;
  const wethRatio     = totalUsd > 0 ? (wethPoolUsd + wethWalletUsd) / totalUsd : null;

  let openingLp = parseFloat((await kv.get('p2_opening_lp').catch(() => null)) ?? 0) || null;
  let revenueGate = null;
  if (openingLp != null) {
    const totalRevenus = wethPoolUsd + usdcPoolUsd + totalAeros + usdcWalletUsd + wethWalletUsd - openingLp;
    revenueGate = { totalRevenus, totalAeros };
  }
  return { wethRatio, revenueGate };
}

async function getGateSnapshotViaApi(base) {
  try {
    const r   = await fetch(`${base}/api/positions2`, { signal: AbortSignal.timeout(15000) });
    const d   = await r.json();
    const pos = d.positions?.[0];
    if (!pos) return null;

    const wethPoolUsd   = parseFloat(pos.pool?.find(t => t.symbol === 'WETH')?.usd ?? 0);
    const usdcPoolUsd   = parseFloat(pos.pool?.find(t => t.symbol === 'USDC')?.usd ?? 0);
    const wethWalletUsd = parseFloat(d.wethWalletUSD ?? 0);
    const usdcWalletUsd = parseFloat(d.usdcWallet ?? 0);
    const totalUsd      = wethPoolUsd + usdcPoolUsd + wethWalletUsd + usdcWalletUsd;
    const wethRatio     = totalUsd > 0 ? (wethPoolUsd + wethWalletUsd) / totalUsd : null;

    let revenueGate = null;
    if (d.openingLp != null) {
      const totalAeros   = parseFloat(pos.aeroRevenueUSD ?? 0) || 0;
      const totalRevenus = parseFloat(pos.totalPoolUSD ?? 0) + totalAeros + usdcWalletUsd + wethWalletUsd - parseFloat(d.openingLp ?? 0);
      revenueGate = { totalRevenus, totalAeros };
    }
    return { wethRatio, revenueGate };
  } catch (_) { return null; }
}

async function getGateSnapshot(base, lpState, rtConfig, rMin, rMax, price) {
  // Le calcul direct ne touche jamais Neon (Redis + RPC uniquement) — recalculé à chaque tick, sans
  // coût supplémentaire et sans le risque de wethRatio périmé jusqu'à 20 min qu'un cache impliquerait
  // (vécu le 29/09 : détection de la Règle 4 retardée après une longue sortie de range). Le cache de
  // 20 min ne protège que l'ancien repli (getGateSnapshotViaApi), qui lui touche Neon.
  const direct = await getGateSnapshotDirect(lpState, rtConfig, rMin, rMax, price).catch(() => null);
  if (direct) return direct;

  const cached = await kv.get('p2_gate_snapshot').catch(() => null);
  if (cached) return cached;

  const snapshot = await getGateSnapshotViaApi(base);
  if (!snapshot) return null;

  await kv.set('p2_gate_snapshot', snapshot, { ex: 20 * 60 }).catch(() => {});
  return snapshot;
}

async function clearAlgoState() {
  await Promise.all([
    kv.del(REDIS_KEYS.POSITION_STATE),
    kv.del(REDIS_KEYS.HEDGE_STATE),
    kv.del(REDIS_KEYS.OOR_SINCE),
    kv.del('p2_edge_streak'),
    kv.del('p2_live_range'),
    kv.del('p2_oor_count'),
    kv.del('p2_oor_low'),
    kv.del('p2_low_zone_bits'),
    kv.del('p2_high_zone_bits'),
  ]);
}

/**
 * Collecte les AERO (pendant que la position est encore stakée), ferme la LP,
 * puis rouvre immédiatement avec tout le capital disponible au ratio voulu.
 * keepCurrentRatio : ignore targetRatio et rouvre avec les proportions WETH/USDC déjà
 * présentes dans le wallet après fermeture (pas de swap pour forcer un ratio) — Règle 1.
 * explicitRangePct : largeur de range imposée (percentile24h × multiplicateur de la règle).
 * aeroLowSplit : fraction AERO envoyée au wallet externe — true = 25% (Règle 2), false = 50% (Règle 3).
 * Spread check (1,5% sur les 20 derniers prix) avant la réouverture : si le marché est trop agité,
 * la réouverture est sautée (capital laissé dans le wallet), la Règle 1 la reprendra au tick
 * suivant une fois le marché calmé.
 */
async function runCollect(base, price, targetRatio = 0.5, closeReason = null, rangeMultiplier = 1, keepCurrentRatio = false, explicitRangePct = null, aeroLowSplit = true, skipAero = false) {
  const out = {};

  let feesCollected = 0;
  if (!skipAero) {
    // Collect AERO avant fermeture — position encore stakée, getReward fonctionne
    for (const step of [1, 2]) {
      try {
        const r = await fetch(`${base}/api/collectFees`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body:    JSON.stringify({ step, poolNum: 2, noTransfer: true }),
          signal:  AbortSignal.timeout(120000),
        });
        out[`step${step}`] = await r.json();
      } catch (e) { out[`step${step}Error`] = e.message; }
    }
    // Montant AERO→USDC réel, lu depuis les logs Transfer du receipt (collectFees step2)
    feesCollected = parseFloat(out.step2?.aeroUsdcReceived ?? 0) || 0;
    out.aeroSplit = await sendAeroSplit(feesCollected, aeroLowSplit);
    await logAndAlertAeroSplit(out, feesCollected);
  } else {
    // Garde-fou largeur (04/10) : pas de retrait AERO sur ce rebalance, juste un redimensionnement
    // de la position — on laisse l'AERO continuer à courir sur le gauge jusqu'au prochain claim.
    out.aeroSplit = { skipped: 'no_aero_on_shrink' };
  }

  // skipAero : aeroSplitFraction=null coupe aussi l'envoi externe du résidu AERO côté closePositions
  // (le unstake peut auto-régler des rewards en attente, mais on ne les envoie pas — ils restent en
  // USDC dans le wallet, repris proprement au prochain vrai cycle de collecte).
  try   { out.closeLP = await closeLP(base, true, closeReason, feesCollected, skipAero ? null : (aeroLowSplit ? 0.25 : 0.5)); }
  catch (e) { out.closeLPError = e.message; }

  // Fermeture ratée (exception ou {error} dans la réponse) → ne pas ouvrir une nouvelle position
  // par-dessus une fermeture incertaine. Le tick suivant reroutera correctement une fois l'état
  // réel resynchronisé (le mail d'erreur est déjà envoyé par /api/closePositions).
  if (out.closeLPError || out.closeLP?.error) {
    out.reopenSkippedCloseFailed = true;
    return out;
  }

  // Réinitialiser l'état algo
  await clearAlgoState();

  // Ratio effectif : soit le ratio cible fourni (swap forcé, Règles 2/3), soit (keepCurrentRatio,
  // Règle 1) les proportions WETH/USDC réellement présentes dans le wallet après la fermeture —
  // aucun swap forcé dans ce cas.
  let effectiveTargetRatio = targetRatio;
  if (keepCurrentRatio) {
    const [usdcBal, wethBal] = await Promise.all([getWalletUsdc(), getWalletWeth()]);
    const capital = usdcBal + wethBal * price;
    effectiveTargetRatio = capital > 0 ? (wethBal * price) / capital : 0.5;
    out.keptRatio = parseFloat(effectiveTargetRatio.toFixed(4));
  }

  // Spread check : marché trop agité → ne pas rouvrir tout de suite. Le capital reste dans le
  // wallet (non réinvesti) ; la position étant fermée, la Règle 1 la rouvrira au tick suivant dès
  // que le marché se sera calmé.
  const recentPrices = await getLastNPrices(20);
  if (recentPrices.length >= 10) {
    const minP   = Math.min(...recentPrices);
    const maxP   = Math.max(...recentPrices);
    const mid    = (minP + maxP) / 2;
    const spread = (maxP - minP) / mid * 100;
    out.spread = parseFloat(spread.toFixed(2));
    if (spread > 1.5) {
      out.reopenSkippedSpread = true;
      // Mémorise les paramètres de la réouverture voulue : la Règle 1 (aucune position) les
      // reprendra au tick suivant au lieu d'ouvrir en gardant les proportions du wallet.
      await kv.set('p2_pending_reopen', {
        targetRatio: effectiveTargetRatio, rangeMultiplier, explicitRangePct,
      }, { ex: 24 * 3600 }).catch(() => {});
      return out;
    }
  }

  // Rouvrir LP avec tout le capital disponible au ratio cible, au prix de marché réel.
  out.autoStart = await autoStart({ base, price, targetRatio: effectiveTargetRatio, rangeMultiplier, explicitRangePct });

  await saveRangeAndLowTrigger(out, price);
  await kv.del('p2_pending_reopen').catch(() => {});

  return out;
}

// Sauvegarde le range réouvert. Les anciennes bornes basse/haute (p2_live_range.lowTrigger/
// highTrigger) ont disparu avec le système de triggers de prix/K dynamique (05/10) — plus aucune
// règle n'en a besoin, les Règles 2/3 se décidant directement sur le ratio WETH de la position.
async function saveRangeAndLowTrigger(out, price) {
  if (!out.autoStart?.pool?.tickLowerPrice || !out.autoStart?.pool?.tickUpperPrice) return;
  const newRMin = out.autoStart.pool.tickLowerPrice;
  const newRMax = out.autoStart.pool.tickUpperPrice;
  await writeP2Range(newRMin, newRMax, price);
}

/**
 * Recrée une position LP avec toute la liquidité disponible au ratio de tendance.
 */
async function autoStart({ base, price, targetRatio = 0.5, rangeMultiplier = 4, explicitRangePct = null }) {
  const result = { action: 'auto_start' };

  // 1. Capital disponible = USDC + WETH dans le wallet
  const [usdcBal, wethBal] = await Promise.all([getWalletUsdc(), getWalletWeth()]);
  const capital = usdcBal + wethBal * price;
  if (capital < 10) return { ...result, skipped: true, reason: `Capital insuffisant : $${capital.toFixed(2)}` };
  result.capital     = parseFloat(capital.toFixed(2));
  result.targetRatio = targetRatio;

  // 2. Range dynamique = rangeMultiplier × percentile 24h (min 2%, fallback 10%), ou explicitRangePct
  // si fourni (ex. Règle 2 : range actuel × 2, indépendant de la volatilité 24h).
  let p24h     = null;
  let rangePct;
  if (explicitRangePct !== null) {
    rangePct = parseFloat(explicitRangePct.toFixed(2));
  } else {
    const pct24h = await getPercentileRange();
    p24h = pct24h && pct24h.cnt >= 10 && pct24h.p05 > 0
      ? (pct24h.p95 - pct24h.p05) / pct24h.p05 * 100
      : null;
    rangePct = parseFloat((p24h !== null ? p24h * rangeMultiplier : 10).toFixed(2));
  }

  const halfFrac = rangePct / 200;
  const minPrice = parseFloat((price / (1 + halfFrac)).toFixed(2));
  const maxPrice = parseFloat((price * (1 + halfFrac)).toFixed(2));
  result.rangePct   = rangePct;
  result.percentile = p24h !== null ? parseFloat(p24h.toFixed(2)) : null;

  // 3. Créer la LP au ratio cible
  const poolRes = await fetch(`${base}/api/createPosition`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body:    JSON.stringify({
      amountUSDC:   capital,
      minPrice,
      maxPrice,
      currentPrice: price,
      rangePercent: rangePct,
      targetRatio,
      poolNum:      ALGO_CONFIG.POOL_NUM,
      exactBounds:  false,
    }),
    signal: AbortSignal.timeout(180000),
  });
  const pool = await poolRes.json();
  if (pool.error) return { ...result, error: `createPosition : ${pool.error}` };
  result.pool = { tickLowerPrice: pool.tickLowerPrice, tickUpperPrice: pool.tickUpperPrice };

  // Convertir le WETH résiduel en USDC
  try {
    const swapRes  = await fetch(`${base}/api/swap-weth-usdc`, { method: 'POST', headers: authHeaders(), signal: AbortSignal.timeout(45000) });
    const swapData = await swapRes.json();
    if (swapData.ok && !swapData.skipped) result.wethSwapped = swapData.wethSwapped;
  } catch (_) {}

  // 5. Sauvegarder la config runtime (sans short)
  const Pa     = pool.tickLowerPrice;
  const Pb     = pool.tickUpperPrice;
  const sqrtPa = Math.sqrt(Pa);
  const sqrtPb = Math.sqrt(Pb);
  const P0_lp  = Math.sqrt(Pa * Pb);
  const L      = capital / (2 * Math.sqrt(P0_lp) - P0_lp / sqrtPb - sqrtPa);

  await kv.set(REDIS_KEYS.RUNTIME_CONFIG, {
    capital, rangePct, liquidityL: L,
    startedAt: new Date().toISOString(),
  }, { ex: 30 * 86400 });
  // Invalide le snapshot wethRatio/revenueGate (Règle 4) : sinon il resterait valable jusqu'à
  // 20 min après cette réouverture, calculé avec le liquidityL/range de l'ANCIENNE position — a
  // provoqué une boucle de 11 rouvertures en 38 min le 27/09 (Règle 4 se redéclenchant à tort sur un
  // wethRatio obsolète). Chaque réouverture passe par autoStart(), donc c'est le seul point commun
  // à toutes les règles (1, 2, 3, 4).
  await kv.del('p2_gate_snapshot').catch(() => {});
  await kv.del(REDIS_KEYS.POSITION_STATE);
  await kv.del(REDIS_KEYS.HEDGE_STATE);
  await kv.del(REDIS_KEYS.OOR_SINCE);
  await kv.set('p2_hedge_fees', 0, { ex: 30 * 86400 });

  // 6. Total au démarrage (Redis + Neon)
  try {
    const openingTotal = parseFloat(capital.toFixed(2));
    // openingLp = capital réellement déployé dans la LP, hors solde resté inutilisé dans le wallet
    // (résidu de swap/arrondi après createPosition + swap-weth-usdc)
    const [usdcDust, wethDust] = await Promise.all([getWalletUsdc(), getWalletWeth()]);
    const dustUsd  = usdcDust + wethDust * price;
    const openingLp = parseFloat(Math.max(0, capital - dustUsd).toFixed(2));
    await kv.set('p2_opening_total', openingTotal, { ex: 30 * 86400 });
    await kv.set('p2_opening_lp',   openingLp, { ex: 30 * 86400 });
    result.openingTotal = openingTotal;
    result.openingLp    = openingLp;

    // Tendance MM14j × MM24h au moment de l'ouverture (ex: "HB", "HH", "BH", "BB")
    const [openAvg14d, openAvg24h] = await Promise.all([getPriceAverage14d(), getPriceAverage24h()]);
    const openTrend = `${trendLetter(price, openAvg14d)}${trendLetter(price, openAvg24h)}`;
    await kv.set('p2_open_trend', openTrend, { ex: 30 * 86400 });
    result.openTrend = openTrend;

    if (process.env.DATABASE_URL && pool.tokenId) {
      const sql = neon(process.env.DATABASE_URL);
      await sql`UPDATE lp_events SET total_at_open = ${openingTotal}, open_trend = ${openTrend} WHERE token_id = ${pool.tokenId} AND COALESCE(pool_num, 2) = 2`;
    }
  } catch (_) {}

  return result;
}

/**
 * Point d'entrée principal, appelé depuis cron/route.js.
 */
export async function botLoop({ base, price }) {
  const result = { price, ts: new Date().toISOString() };

  if (!price) {
    result.skipped = true;
    result.reason  = 'prix indisponible';
    return result;
  }

  if (!BOT_ENABLED) {
    result.action = 'bot_disabled';
    await logBotTick(kv, result);
    return result;
  }

  // 1. État LP + config runtime + compteur de confirmation Règles 2/3 (en parallèle)
  const [lpState, rtConfig, oorCountRaw] = await Promise.all([
    readLpState(ALGO_CONFIG.POOL_NUM),
    kv.get(REDIS_KEYS.RUNTIME_CONFIG),
    kv.get('p2_oor_count').catch(() => null),
  ]);

  const hasLP   = !!(lpState && lpState.action2 === null);
  let rMin = hasLP ? parseFloat(lpState.range_min) : null;
  let rMax = hasLP ? parseFloat(lpState.range_max) : null;

  // Règle 4 : si aucun envoi vers le wallet externe (Règles 2/3 ou ce claim lui-même) n'a eu lieu
  // depuis 24h glissantes, réclame les AERO accumulés sans fermer la LP et en envoie 25% au wallet
  // externe (75% restent en solde USDC non utilisé dans le wallet du bot) — garantit un minimum
  // d'envoi régulier même quand le marché reste calme (aucun trigger WETH déclenché). Sur skip
  // (rien à réclamer/non stakée) on repousse quand même le compteur de 24h, pour ne pas retenter à
  // chaque tick jusqu'à ce qu'il y ait effectivement quelque chose à claim.
  if (hasLP) {
    const lastSendAt = parseInt(await kv.get('p2_last_aero_send_at').catch(() => null)) || 0;
    if (Date.now() - lastSendAt > 24 * 3600 * 1000) {
      try {
        const r = await fetch(`${base}/api/claimAero`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ poolNum: 2, sendFraction: 0.25, source: 'periodic_24h_claim' }),
          signal: AbortSignal.timeout(60000),
        });
        result.periodicClaim = await r.json();
      } catch (e) { result.periodicClaim = { error: e.message }; }
      if (result.periodicClaim?.ok || result.periodicClaim?.skipped) {
        await kv.set('p2_last_aero_send_at', Date.now(), { ex: 30 * 86400 }).catch(() => {});
      }
    }
  }

  // Range réel (fallback si absent de lpState, ex. juste après un retry-stake)
  if (hasLP && (rMin == null || isNaN(rMin))) {
    const lr = await readP2Range();
    if (lr?.min) {
      rMin = parseFloat(lr.min);
      rMax = parseFloat(lr.max);
      console.log(`[botLoop] range lu depuis p2_live_range: ${rMin}–${rMax}`);
    }
  }

  const centerPrice = (!isNaN(rMin) && !isNaN(rMax) && rMin > 0 && rMax > 0)
    ? Math.sqrt(rMin * rMax)
    : null;

  result.hasLP       = hasLP;
  result.rMin        = rMin ?? null;
  result.rMax        = rMax ?? null;
  result.centerPrice = centerPrice ? parseFloat(centerPrice.toFixed(2)) : null;
  result.poolNum     = ALGO_CONFIG.POOL_NUM;

  // Règles 2 et 3 : déclenchées sur le ratio WETH de la position (pool + wallet), confirmées sur 5
  // ticks consécutifs — même compteur/dots que l'ancien système (p2_oor_count/p2_oor_low, affichés
  // sur la page pools), pour ne pas rebalancer sur un ratio qui ne fait que passer la frontière un
  // instant. oorLow=true (dots rouges) = Règle 2 (trigger bas) ; oorLow=false (dots cyan) = Règle 3.
  if (hasLP) {
    const wethRatio = (await getGateSnapshot(base, lpState, rtConfig, rMin, rMax, price))?.wethRatio ?? null;
    result.wethRatio = wethRatio;

    const inLowZone  = wethRatio !== null && wethRatio >= 0.95;
    const inHighZone = wethRatio !== null && wethRatio <= 0.05;

    if (inLowZone || inHighZone) {
      const newCount = (parseInt(oorCountRaw) || 0) + 1;
      await kv.set('p2_oor_count', newCount, { ex: 30 * 86400 });
      await kv.set('p2_oor_low', inLowZone ? 1 : 0, { ex: 30 * 86400 });
      result.oorCount = newCount;
      result.isOORLow = inLowZone;

      if (newCount < 5) {
        result.action = 'oor_waiting';
        await logBotTick(kv, result);
        return result;
      }

      await kv.del('p2_oor_count').catch(() => {});
      await kv.del('p2_oor_low').catch(() => {});

      if (inLowZone) {
        // Règle 2 : trigger bas (position quasi entièrement en WETH) — collecte AERO (25%
        // envoyé/75% gardé), ferme et rouvre à 75% WETH (swap forcé), largeur = percentile24h × 1.25.
        // Plancher 1.5% (04/10) : évite une range trop étroite si le percentile24h est anormalement
        // bas, qui ferait ressortir la position presque aussitôt, en boucle.
        const pctData2 = await getPercentileRange();
        const p24h2    = pctData2 && pctData2.cnt >= 10 && pctData2.p05 > 0
          ? (pctData2.p95 - pctData2.p05) / pctData2.p05 * 100
          : null;
        const width2 = p24h2 !== null ? Math.max(p24h2 * 1.25, 1.5) : 1.5;
        await writeRule1K(1);
        result.rule1K          = 1;
        result.action          = 'low_trigger';
        result.percentileRange = p24h2 !== null ? parseFloat(p24h2.toFixed(2)) : null;
        result.newRangePct     = parseFloat(width2.toFixed(2));
        result.collect = await runCollect(base, price, 0.75, 'low_trigger', 1, false, width2, true);
        await logBotTick(kv, result);
        return result;
      }

      // Règle 3 : trigger haut (position quasi entièrement en USDC) — collecte AERO (50%
      // envoyé/50% gardé), ferme et rouvre à 25% WETH (swap forcé), largeur = percentile24h brut.
      const pctData3 = await getPercentileRange();
      const p24h3    = pctData3 && pctData3.cnt >= 10 && pctData3.p05 > 0
        ? (pctData3.p95 - pctData3.p05) / pctData3.p05 * 100
        : null;
      const width3 = p24h3 !== null ? Math.max(p24h3, 1.5) : 1.5;
      await writeRule1K(1);
      result.rule1K          = 1;
      result.action          = 'high_trigger';
      result.percentileRange = p24h3 !== null ? parseFloat(p24h3.toFixed(2)) : null;
      result.newRangePct     = parseFloat(width3.toFixed(2));
      result.collect = await runCollect(base, price, 0.25, 'high_trigger', 1, false, width3, false);
      await logBotTick(kv, result);
      return result;
    }

    // Ratio hors des deux zones → reset compteur
    if (oorCountRaw) { await kv.del('p2_oor_count').catch(() => {}); await kv.del('p2_oor_low').catch(() => {}); }

    // Règle 5 : le range actuel est devenu trop large par rapport à la volatilité réelle (percentile24h
    // tombé à au moins 1pt sous la largeur actuelle) → resserre directement à range_percentile, SANS
    // swap (garde les proportions WETH/USDC actuelles de la position). Vérifiée à chaque tick, pas de
    // confirmation sur plusieurs ticks (le percentile24h est déjà une moyenne glissante sur 24h, donc
    // peu sujet au bruit instantané, contrairement au prix/ratio). Plancher 1,5% comme les autres règles.
    if (!isNaN(rMin) && !isNaN(rMax)) {
      const rangePctActuel5 = (rMax - rMin) / rMin * 100;
      const pctData5        = await getPercentileRange();
      const p24h5           = pctData5 && pctData5.cnt >= 10 && pctData5.p05 > 0
        ? (pctData5.p95 - pctData5.p05) / pctData5.p05 * 100
        : null;
      if (p24h5 !== null && rangePctActuel5 - p24h5 > 1) {
        const width5 = Math.max(p24h5, 1.5);
        await writeRule1K(1);
        result.rule1K          = 1;
        result.action          = 'width_shrink_rebalance';
        result.rangePctActuel  = parseFloat(rangePctActuel5.toFixed(2));
        result.percentileRange = parseFloat(p24h5.toFixed(2));
        result.newRangePct     = parseFloat(width5.toFixed(2));
        result.collect = await runCollect(base, price, 0.5, 'width_shrink_rebalance', 1, true, width5, true, true);
        await logBotTick(kv, result);
        return result;
      }
    }
  }

  // Règle 1 : aucune position → auto-start
  if (!hasLP) {
    // Vérifier si Redis est désynchronisé (position active en DB, Redis dit CLOSE_OK) — mais ne
    // restaure cette ligne que si le NFT existe encore réellement on-chain avec de la liquidité.
    // Sans cette vérification, une ligne lp_events restée bloquée à action2 IS NULL (ex. l'UPDATE
    // de closePositions censé marquer CLOSE_OK n'a pas matché, alors que le NFT a bien été brûlé)
    // est restaurée en Redis à chaque tick pour toujours — ce qui bloque la Règle 1 indéfiniment
    // (incident du 05/10 : "execution reverted: ID" sur la page pools, aucune réouverture).
    try {
      const sqlCheck = neon(process.env.DATABASE_URL);
      const dbRows = await sqlCheck`
        SELECT * FROM lp_events
        WHERE action1 = 'CREATE_OK' AND action2 IS NULL AND token_id IS NOT NULL
          AND COALESCE(pool_num, 2) = ${ALGO_CONFIG.POOL_NUM}
        ORDER BY id DESC LIMIT 1
      `;
      const staleTokenId = dbRows[0]?.token_id;
      if (staleTokenId) {
        let stillExists = false;
        try {
          const posHex = await ethCall(NFPM_ADDRESS, '0x99fbab88' + BigInt(staleTokenId).toString(16).padStart(64, '0'));
          const hex = posHex.startsWith('0x') ? posHex.slice(2) : posHex;
          const liquidityHex = hex.slice(7 * 64, 8 * 64);
          stillExists = liquidityHex ? BigInt('0x' + liquidityHex) > 0n : false;
        } catch (e) {
          // "execution reverted" = réponse ferme de la blockchain (NFT brûlé, pas une panne réseau)
          stillExists = !/revert/i.test(e.message ?? '');
        }
        if (stillExists) {
          await writeLpState(ALGO_CONFIG.POOL_NUM, dbRows[0]);
          result.action = 'redis_restored';
          await logBotTick(kv, result);
          return result;
        }
        // Ligne DB périmée (NFT confirmé disparu) : la clôturer pour de bon, sinon elle revient à
        // chaque tick et la Règle 1 ne peut plus jamais s'exécuter.
        try {
          await sqlCheck`UPDATE lp_events SET action2 = 'CLOSE_OK', closed_at = NOW(), close_reason = 'orphan_stale_row'
                          WHERE token_id = ${staleTokenId} AND action1 = 'CREATE_OK' AND action2 IS NULL`;
        } catch (_) {}
      }
    } catch (_) {}

    // Spread check : marché trop agité → attendre
    const recentPrices = await getLastNPrices(20);
    if (recentPrices.length >= 10) {
      const minP   = Math.min(...recentPrices);
      const maxP   = Math.max(...recentPrices);
      const mid    = (minP + maxP) / 2;
      const spread = (maxP - minP) / mid * 100;
      result.spread = parseFloat(spread.toFixed(2));
      if (spread > 1.5) {
        result.action = 'auto_start_spread_skip';
        await logBotTick(kv, result);
        return result;
      }
    }

    // Règle 1 : aucune position → ouvre en gardant les proportions WETH/USDC déjà présentes dans
    // le wallet (pas de swap forcé), largeur = percentile24h brut. Sauf si une réouverture a été
    // retardée par le spread check (Règles 1/2/3) : on reprend alors exactement ses paramètres au
    // lieu de repartir de zéro.
    const pending = await kv.get('p2_pending_reopen').catch(() => null);
    if (pending) {
      result.autoStart = await autoStart({
        base, price,
        targetRatio:      pending.targetRatio ?? 0.5,
        rangeMultiplier:  pending.rangeMultiplier ?? 1,
        explicitRangePct: pending.explicitRangePct ?? null,
      });
      result.pendingReopen = true;
      if (!result.autoStart.skipped && !result.autoStart.error) {
        await saveRangeAndLowTrigger(result, price);
        await kv.del('p2_pending_reopen').catch(() => {});
      }
    } else {
      // K (p2_rule1_k, Redis + repli table bot_config) : réinitialisé à 1 — pure information
      // affichée sur la page pools, ne pilote plus aucune formule depuis la refonte du 05/10.
      await writeRule1K(1);
      result.rule1K = 1;

      // Garder les proportions WETH/USDC déjà présentes dans le wallet (aucune LP à fermer ici,
      // donc lues directement, pas via keepCurrentRatio de runCollect) — plafonnées à 70/30 (05/10) :
      // un ratio trop loin de 50/50 force le centre du range (étroit, percentile24h) à se placer
      // presque collé à un bord, où le ratio "correct" est hyper-sensible au prix — tout mouvement
      // pendant les ~30-60s de swaps/confirmations du mint peut alors laisser une grosse part du
      // capital non déployée (incident du 05/10 : $281 sur $607 restés inutilisés dans le wallet).
      const [usdcBal1, wethBal1] = await Promise.all([getWalletUsdc(), getWalletWeth()]);
      const capital1   = usdcBal1 + wethBal1 * price;
      const rawRatio1  = capital1 > 0 ? (wethBal1 * price) / capital1 : 0.5;
      const keptRatio1 = Math.min(0.70, Math.max(0.30, rawRatio1));
      result.rawKeptRatio = parseFloat(rawRatio1.toFixed(4));
      result.keptRatio    = parseFloat(keptRatio1.toFixed(4));

      // Largeur = max(percentile24h, 1.5% plancher absolu) — plancher ajouté le 04/10 (incident où
      // percentile24h est tombé à 0.47%, donnant une range si étroite que la position ressortait
      // presque aussitôt, en boucle).
      const pctData1 = await getPercentileRange();
      const p24h1    = pctData1 && pctData1.cnt >= 10 && pctData1.p05 > 0
        ? (pctData1.p95 - pctData1.p05) / pctData1.p05 * 100
        : null;
      const width1   = p24h1 !== null ? Math.max(p24h1, 1.5) : 1.5;
      result.autoStart = await autoStart({ base, price, targetRatio: keptRatio1, explicitRangePct: width1 });
      if (!result.autoStart.skipped && !result.autoStart.error) {
        await saveRangeAndLowTrigger(result, price);
      }
    }
    result.action    = result.autoStart.skipped ? 'auto_start_skipped' : 'auto_started';
    await logBotTick(kv, result);
    return result;
  }

  // En range, position active → rien à faire
  result.action = 'in_range_ok';

  await logBotTick(kv, result);
  return result;
}
