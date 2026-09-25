import { ethers }           from 'ethers';
import { kv }               from '@vercel/kv';
import { neon }             from '@neondatabase/serverless';
import { ALGO_CONFIG, REDIS_KEYS } from '../config.js';
import { readLpState, writeLpState, readP2Range, writeP2Range, getPercentileRange, getPriceAverage14d, getPriceAverage24h, getLastNPrices, wasAeroSentToday, writeAeroSentToday } from '../../cronKv.js';
import { NFPM_ADDRESS } from '../../config.js';
import { logBotTick }       from './metrics.js';

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
// BOT_ENABLED = true — seules les Règles 1, 2, 3, 4 ci-dessous sont actives (anciennes 1c/1d désactivées).
// Nouveau jeu de règles :
//   1.  Aucune position → ouvre au range percentile24h brut (×1), 50/50 WETH/USDC.
//   2.  Zone basse (prix ≤ rMin + 25% du range), confirmée 5 ticks consécutifs (compteur
//       p2_oor_count/p2_oor_low, dots page pools) → collecte AERO (25% envoyé/75% gardé),
//       ferme et rouvre range doublé sans swap (cap 75% WETH si WETH>80%).
//   3.  Zone haute (prix ≥ rMin + 50% du range), confirmée 5 ticks consécutifs (même compteur) ET
//       écart percentile24h/range actuel > ±1,5pt (revérifié à chaque tick une fois le streak
//       atteint) → collecte AERO (50%/50%), resize sans swap au range percentile24h brut,
//       garde les proportions WETH/USDC actuelles (aucun plafond/plancher de ratio).
//   4.  Indépendante des zones/volatilité, vérifiée chaque tick sans streak : si WETH < 5% de la
//       position → collecte AERO (50%/50%), ferme et rouvre au même range (pas de resize), swap
//       forcé vers 25% WETH (correctif modéré, pas un reset à 50%, pour limiter le rachat de WETH
//       à un prix haut).
//   Ancienne Règle 1A (zone de bord 5%) : supprimée, devenue inatteignable (Règles 2/3 couvrent
//   déjà ses zones et s'évaluent avant).
//   Anciennes Règles 1c et 1d [toutes deux désactivées] : code encore présent plus bas, pas
//   encore supprimé, mais RULE_1C_ENABLED/RULE_1D_ENABLED = false → jamais évaluées.
//   Claim matinal (7h Paris) [DÉSACTIVÉ, MORNING_CLAIM_ENABLED = false] : si aucun AERO envoyé
//   aujourd'hui, retire 25% des AERO accumulés sans fermer la LP.
//   Réouvertures Règles 2/3/4 : spread check (1,5% sur 20 derniers prix, même seuil que la Règle 1)
//   avant de rouvrir — si le marché est trop agité, la réouverture est sautée, la Règle 1 la
//   reprendra au tick suivant.

// Coupe-circuit global : si false, botLoop() ne fait plus rien du tout (aucune règle, aucun claim
// matinal) — la position ouverte reste telle quelle, en attente. Le code de chaque règle reste
// intact, prêt à repartir en repassant ce flag à true.
const BOT_ENABLED = true;

// Anciennes règles 1c/1d désactivées — seules les nouvelles Règles 1, 2, 3, 4 sont actives.
const RULE_1C_ENABLED = false;
const RULE_1D_ENABLED = false;
const MORNING_CLAIM_ENABLED = false;

// Lettre de tendance vs une moyenne mobile : H (haussier, prix ≥ MM) ou B (baissier, prix < MM) — binaire, pas de zone neutre
function trendLetter(price, avg) {
  if (!price || avg == null) return 'B';
  return price >= avg ? 'H' : 'B';
}

// Ratio WETH de réouverture — MM14j = tendance de fond (directeur), MM24h = signal mean-reversion
// à l'intérieur de cette tendance (un creux 24h dans une tendance haussière = meilleur point
// d'achat, d'où le B (MM24h en dessous) qui pousse le ratio vers le haut, pas vers le bas).
//   HB (tendance haussière + creux 24h)   → 0.8 : meilleur point d'entrée WETH
//   BH (tendance baissière + rebond 24h)  → 0.2 : meilleur point de sortie WETH
//   HH / BB (le 24h confirme la tendance, pas de creux/rebond) → ratio plus modéré
const REOPEN_RATIO_GRID = {
  H: { H: 0.6, B: 0.8 },
  B: { H: 0.2, B: 0.4 },
};
function reopenRatioFromTrends(t14, t24) {
  return REOPEN_RATIO_GRID[t14]?.[t24] ?? 0.5;
}

const USDC_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
const ERC20_IFACE  = new ethers.Interface(['function transfer(address,uint256) returns (bool)']);
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


// Verse une fraction des AERO déjà convertis en USDC vers DESTINATION_WALLET.
// Règle 1A (sortie directionnelle) : haut → 50% envoyés/50% gardés ; bas → 25%/75%.
// Règle 1c (resserrement/élargissement, pas de direction) : toujours 25%/75% (isLow=true).
async function sendAeroSplit(feesCollectedUsdc, isLow) {
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
                VALUES (${toSend}, ${isLow ? 'edge_low_25pct' : 'edge_high_50pct'}, ${txHash}, ${2})`;
  } catch (_) {}
  await writeAeroSentToday(2).catch(() => {});
  // Compte aussi comme un envoi externe pour la Règle 5 (claim périodique 24h) — évite un envoi
  // redondant peu après si une sortie de zone vient déjà d'en déclencher un.
  await kv.set('p2_last_aero_send_at', Date.now(), { ex: 30 * 86400 }).catch(() => {});

  return { ok: true, sent: toSend, kept: parseFloat((feesCollectedUsdc - toSend).toFixed(6)), txHash, side: isLow ? 'low' : 'high', fraction };
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
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ keepWeth, poolNum: ALGO_CONFIG.POOL_NUM, caseNum: 9, noTransfer: true, closeReason, feesUsdc, aeroSplitFraction }),
    signal:  AbortSignal.timeout(120000),
  });
  return res.json();
}

// Total revenus (pool + AERO + solde wallet − capital déployé) et part AERO de ce total,
// mêmes formules que l'affichage "Total revenus" / badge AERO sur la page pools.
async function getRevenueGate(base) {
  try {
    const r   = await fetch(`${base}/api/positions2`, { signal: AbortSignal.timeout(15000) });
    const d   = await r.json();
    const pos = d.positions?.[0];
    if (!pos || d.openingLp == null) return null;
    const totalAeros   = parseFloat(pos.aeroRevenueUSD ?? 0) || 0;
    const totalRevenus = parseFloat(pos.totalPoolUSD ?? 0) + totalAeros
      + parseFloat(d.usdcWallet ?? 0) + parseFloat(d.wethWalletUSD ?? 0) - parseFloat(d.openingLp ?? 0);
    return { totalRevenus, totalAeros };
  } catch (_) { return null; }
}

// Part de la valeur totale (LP + wallet) actuellement en WETH — pour la Règle 4 (plancher WETH).
async function getWethRatio(base) {
  try {
    const r   = await fetch(`${base}/api/positions2`, { signal: AbortSignal.timeout(15000) });
    const d   = await r.json();
    const pos = d.positions?.[0];
    if (!pos) return null;
    const wethPoolUsd = parseFloat(pos.pool?.find(t => t.symbol === 'WETH')?.usd ?? 0);
    const usdcPoolUsd = parseFloat(pos.pool?.find(t => t.symbol === 'USDC')?.usd ?? 0);
    const wethWalletUsd = parseFloat(d.wethWalletUSD ?? 0);
    const usdcWalletUsd = parseFloat(d.usdcWallet ?? 0);
    const totalUsd = wethPoolUsd + usdcPoolUsd + wethWalletUsd + usdcWalletUsd;
    if (totalUsd <= 0) return null;
    return (wethPoolUsd + wethWalletUsd) / totalUsd;
  } catch (_) { return null; }
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

async function closeEdgeZone(base, isLow) {
  const out = {};

  for (const step of [1, 2]) {
    try {
      const r = await fetch(`${base}/api/collectFees`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ step, poolNum: 2, noTransfer: true }),
        signal:  AbortSignal.timeout(120000),
      });
      out[`step${step}`] = await r.json();
    } catch (e) { out[`step${step}Error`] = e.message; }
  }
  // Montant AERO→USDC réel, lu depuis les logs Transfer du receipt (collectFees step2) —
  // fiable, contrairement à un diff de solde wallet avant/après sur des requêtes séparées.
  const feesCollected = parseFloat(out.step2?.aeroUsdcReceived ?? 0) || 0;
  out.aeroSplit = await sendAeroSplit(feesCollected, isLow);
  await logAndAlertAeroSplit(out, feesCollected);

  try   { out.closeLP = await closeLP(base, true, isLow ? 'oor_close_low' : 'oor_close_high', feesCollected, isLow ? 0.25 : 0.5); } // pas de swap forcé, quel que soit le côté
  catch (e) { out.closeLPError = e.message; }

  // Mémorise le côté de sortie pour déterminer le ratio de réouverture (Règle 2, tick suivant)
  try { await kv.set('p2_last_exit_side', isLow ? 'low' : 'high', { ex: 3600 }); } catch (_) {}

  await clearAlgoState();
  return out;
}

/**
 * Collecte les AERO (pendant que la position est encore stakée), ferme la LP,
 * puis rouvre immédiatement avec tout le capital disponible au ratio de tendance.
 * keepCurrentRatio : ignore targetRatio et rouvre avec les proportions WETH/USDC déjà
 * présentes dans le wallet après fermeture (pas de swap pour forcer un ratio).
 * maxWethCap / minWethCap : { trigger, target } — si keepCurrentRatio dépasse trigger (côté haut)
 * ou passe sous trigger (côté bas), on force le ratio à target à la place (swap partiel).
 *   Règle 2 : maxWethCap = { trigger: 0.80, target: 0.75 }
 *   Règle 3 : aucun (garde les proportions actuelles sans plafond/plancher)
 * explicitRangePct : largeur de range imposée (ex. range actuel doublé), sinon percentile×rangeMultiplier.
 * aeroLowSplit : fraction AERO envoyée au wallet externe — true = 25% (Règles 1c/2), false = 50% (Règle 3).
 * Spread check (même seuil que la Règle 1, 1.5% sur les 20 derniers prix) avant la réouverture :
 * si le marché est trop agité, la réouverture est sautée (capital laissé dans le wallet), la
 * Règle 1 la reprendra au tick suivant une fois le marché calmé.
 */
async function runCollect(base, price, targetRatio = 0.5, closeReason = null, rangeMultiplier = 4, keepCurrentRatio = false, explicitRangePct = null, maxWethCap = null, minWethCap = null, aeroLowSplit = true, lowTriggerMode = 'reset', oldLowTrigger = null, skipAeroSplit = false) {
  const out = {};

  // Collect AERO avant fermeture — position encore stakée, getReward fonctionne
  for (const step of [1, 2]) {
    try {
      const r = await fetch(`${base}/api/collectFees`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ step, poolNum: 2, noTransfer: true }),
        signal:  AbortSignal.timeout(120000),
      });
      out[`step${step}`] = await r.json();
    } catch (e) { out[`step${step}Error`] = e.message; }
  }
  // Montant AERO→USDC réel, lu depuis les logs Transfer du receipt (collectFees step2)
  const feesCollected = parseFloat(out.step2?.aeroUsdcReceived ?? 0) || 0;
  // skipAeroSplit : règle qui doit garder 100% des fees/AERO dans la position (pas d'envoi externe
  // ce cycle) — on n'appelle même pas sendAeroSplit pour éviter toute tentative de transfert.
  out.aeroSplit = skipAeroSplit ? { skipped: 'rule_no_external_send' } : await sendAeroSplit(feesCollected, aeroLowSplit);
  await logAndAlertAeroSplit(out, feesCollected);

  // Fermer la LP — aeroSplitFraction=null coupe aussi le split résiduel côté closePositions
  // (sinon il enverrait quand même une part de l'AERO résiduel swappé pendant la fermeture)
  try   { out.closeLP = await closeLP(base, true, closeReason, feesCollected, skipAeroSplit ? null : (aeroLowSplit ? 0.25 : 0.5)); }
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

  // Mémorise la perte réalisée par CE cycle qui se termine ici (Règle 2 uniquement) — sert de
  // référence à la Règle 1f pour savoir si les revenus du nouveau cycle l'ont compensée (0 si ce
  // cycle était en fait gagnant, pour ne pas bloquer la Règle 1f sur un gain à dépasser).
  if (closeReason === 'low_zone_rebalance') {
    try {
      const openingBefore   = parseFloat((await kv.get('p2_opening_total')) ?? 0) || 0;
      const [usdcBal, wethBal] = await Promise.all([getWalletUsdc(), getWalletWeth()]);
      const valueAfterClose = usdcBal + wethBal * price;
      const cycleLoss       = Math.max(0, openingBefore - valueAfterClose);
      await kv.set('p2_prev_cycle_loss', cycleLoss, { ex: 30 * 86400 }).catch(() => {});
    } catch (_) {}
  }

  // Ratio effectif : soit le ratio cible fourni, soit (keepCurrentRatio) les proportions
  // WETH/USDC réellement présentes dans le wallet après la fermeture — aucun swap forcé,
  // sauf si ça franchit le trigger de maxWethCap/minWethCap (swap partiel vers leur target).
  let effectiveTargetRatio = targetRatio;
  if (keepCurrentRatio) {
    const [usdcBal, wethBal] = await Promise.all([getWalletUsdc(), getWalletWeth()]);
    const capital = usdcBal + wethBal * price;
    effectiveTargetRatio = capital > 0 ? (wethBal * price) / capital : 0.5;
    out.keptRatio = parseFloat(effectiveTargetRatio.toFixed(4));
    if (maxWethCap && effectiveTargetRatio > maxWethCap.trigger) {
      effectiveTargetRatio = maxWethCap.target;
      out.cappedRatio = maxWethCap.target;
    } else if (minWethCap && effectiveTargetRatio < minWethCap.trigger) {
      effectiveTargetRatio = minWethCap.target;
      out.cappedRatio = minWethCap.target;
    }
  }

  // Spread check : marché trop agité → ne pas rouvrir tout de suite (même seuil que la Règle 1).
  // Le capital reste dans le wallet (non réinvesti) ; la position étant fermée, la Règle 1 la
  // rouvrira au tick suivant dès que le marché se sera calmé.
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
      // reprendra au tick suivant au lieu d'ouvrir en 50/50 avec le percentile brut.
      await kv.set('p2_pending_reopen', {
        targetRatio: effectiveTargetRatio, rangeMultiplier, explicitRangePct, lowTriggerMode, oldLowTrigger, closeReason,
      }, { ex: 24 * 3600 }).catch(() => {});
      return out;
    }
  }

  // Rouvrir LP avec tout le capital disponible au ratio cible
  out.autoStart = await autoStart({ base, price, targetRatio: effectiveTargetRatio, rangeMultiplier, explicitRangePct });

  // Sauvegarder le nouveau range + low trigger (et purger une éventuelle réouverture en attente)
  await saveRangeAndLowTrigger(out, price, lowTriggerMode, oldLowTrigger);
  await kv.del('p2_pending_reopen').catch(() => {});
  // Mémorise la raison de CETTE ouverture — sert à la Règle 1f pour détecter une position issue
  // d'une sortie basse (Règle 2), indépendamment de ce qui se passe ensuite dans son cycle. Seulement
  // si l'ouverture a réellement abouti (même garde que saveRangeAndLowTrigger).
  if (out.autoStart?.pool?.tickLowerPrice && out.autoStart?.pool?.tickUpperPrice) {
    await kv.set('p2_open_reason', closeReason, { ex: 30 * 86400 }).catch(() => {});
  }

  return out;
}

// Sauvegarde le range réouvert + low trigger : 'halve' = se rapproche du nouveau rMin (sortie basse
// répétée), sinon reset à rMin + 25% du nouveau range (sortie haute, Règle 4, défaut).
async function saveRangeAndLowTrigger(out, price, lowTriggerMode, oldLowTrigger) {
  if (!out.autoStart?.pool?.tickLowerPrice || !out.autoStart?.pool?.tickUpperPrice) return;
  const newRMin = out.autoStart.pool.tickLowerPrice;
  const newRMax = out.autoStart.pool.tickUpperPrice;
  // Plafonné au milieu de [newRMin, prix de réouverture] : garantit que le prix reste au-dessus du
  // trigger dès la réouverture (sinon re-déclenchement immédiat en boucle si le prix a décroché).
  const newLowTrigger = (lowTriggerMode === 'halve' && oldLowTrigger !== null)
    ? Math.min((oldLowTrigger + newRMin) / 2, (newRMin + price) / 2)
    : newRMin + 0.25 * (newRMax - newRMin);
  out.newLowTrigger = parseFloat(newLowTrigger.toFixed(2));
  await writeP2Range(newRMin, newRMax, price, newLowTrigger);
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
    headers: { 'Content-Type': 'application/json' },
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
    const swapRes  = await fetch(`${base}/api/swap-weth-usdc`, { method: 'POST', signal: AbortSignal.timeout(45000) });
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

  // 1. État LP + config runtime + compteur OOR (en parallèle)
  const [lpState, rtConfig, oorCountRaw, avg14d, avg24h] = await Promise.all([
    readLpState(ALGO_CONFIG.POOL_NUM),
    kv.get(REDIS_KEYS.RUNTIME_CONFIG),
    kv.get('p2_oor_count').catch(() => null),
    getPriceAverage14d(),
    getPriceAverage24h(),
  ]);

  // Tendance MM14j × MM24h → ratio de réouverture dynamique (utilisé Règles 1c, 1d et 2)
  const trend14d        = trendLetter(price, avg14d);
  const trend24h        = trendLetter(price, avg24h);
  const reopenRatio     = reopenRatioFromTrends(trend14d, trend24h);
  const currentTrendCode = `${trend14d}${trend24h}`;
  result.avg14d      = avg14d;
  result.avg24h      = avg24h;
  result.trend14d    = trend14d;
  result.trend24h    = trend24h;
  result.reopenRatio = reopenRatio;
  result.currentTrendCode = currentTrendCode;

  // Suivi de la stabilité de la tendance courante (depuis quand le code HH/HB/… n'a pas changé) — pour Règle 1d
  const trackedTrend = await kv.get('p2_trend_track').catch(() => null);
  let trendSince = Date.now();
  if (trackedTrend?.code === currentTrendCode && trackedTrend?.since) {
    trendSince = trackedTrend.since;
  } else {
    await kv.set('p2_trend_track', { code: currentTrendCode, since: trendSince }, { ex: 30 * 86400 }).catch(() => {});
  }
  result.trendStableMs = Date.now() - trendSince;
  const hasLP   = !!(lpState && lpState.action2 === null);
  let rMin = hasLP ? parseFloat(lpState.range_min) : null;
  let rMax = hasLP ? parseFloat(lpState.range_max) : null;

  // Claim AERO matinal (7h Paris) : si rien n'a encore été envoyé aujourd'hui, on retire 25% des
  // AERO accumulés sans fermer la LP (le reste des règles s'évalue normalement après, ce n'est
  // pas un `return` anticipé).
  if (MORNING_CLAIM_ENABLED && hasLP) {
    const parisHour = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }).format(new Date()), 10);
    if (parisHour >= 7 && !(await wasAeroSentToday(2).catch(() => false))) {
      try {
        const r = await fetch(`${base}/api/claimAero`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ poolNum: 2, sendFraction: 0.25 }),
          signal: AbortSignal.timeout(60000),
        });
        result.morningClaim = await r.json();
      } catch (e) { result.morningClaim = { error: e.message }; }
      // Rien à réclamer (non staké) ou déjà envoyé → pas la peine de retenter à chaque tick jusqu'à demain
      if (result.morningClaim?.ok || result.morningClaim?.skipped) await writeAeroSentToday(2).catch(() => {});
    }
  }

  // Règle 5 : si aucun envoi vers le wallet externe (Règles 2/3/1e/1f ou ce claim lui-même) n'a eu
  // lieu depuis 24h glissantes, réclame les AERO accumulés sans fermer la LP et en envoie 25% au
  // wallet externe (75% restent en solde USDC non utilisé dans le wallet du bot) — garantit un
  // minimum d'envoi régulier même quand le marché reste calme (aucune sortie de zone déclenchée).
  // Sur skip (rien à réclamer/non stakée) on repousse quand même le compteur de 24h, pour ne pas
  // retenter à chaque tick jusqu'à ce qu'il y ait effectivement quelque chose à claim.
  const PERIODIC_AERO_CLAIM_ENABLED = true;
  if (PERIODIC_AERO_CLAIM_ENABLED && hasLP) {
    const lastSendAt = parseInt(await kv.get('p2_last_aero_send_at').catch(() => null)) || 0;
    if (Date.now() - lastSendAt > 24 * 3600 * 1000) {
      try {
        const r = await fetch(`${base}/api/claimAero`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
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

  // Lire p2_live_range : range réel (fallback si absent de lpState) + low trigger stocké
  let storedLowTrigger = null;
  if (hasLP) {
    const lr = await readP2Range();
    if (rMin == null || isNaN(rMin)) {
      if (lr?.min) {
        rMin = parseFloat(lr.min);
        rMax = parseFloat(lr.max);
        console.log(`[botLoop] range lu depuis p2_live_range: ${rMin}–${rMax}`);
      }
    }
    if (lr?.lowTrigger) storedLowTrigger = parseFloat(lr.lowTrigger);
  }

  const centerPrice = (!isNaN(rMin) && !isNaN(rMax) && rMin > 0 && rMax > 0)
    ? Math.sqrt(rMin * rMax)
    : null;

  result.hasLP       = hasLP;
  result.rMin        = rMin ?? null;
  result.rMax        = rMax ?? null;
  result.centerPrice = centerPrice ? parseFloat(centerPrice.toFixed(2)) : null;
  result.poolNum     = ALGO_CONFIG.POOL_NUM;

  // Règle 4 : indépendante des zones/volatilité — si WETH < 5% de la position, recale à 25% WETH
  // (swap partiel), quel que soit l'endroit du range où se trouve le prix. Vérifiée à chaque tick,
  // pas de streak de confirmation (contrairement aux Règles 2/3).
  if (hasLP) {
    const wethRatio = await getWethRatio(base);
    result.wethRatio = wethRatio;
    if (wethRatio !== null && wethRatio < 0.05) {
      const rangePctActuel = (!isNaN(rMin) && !isNaN(rMax)) ? (rMax - rMin) / rMin * 100 : null;
      result.action = 'weth_floor_rebalance';
      result.collect = await runCollect(base, price, 0.25, 'weth_floor_rebalance', 1, false, rangePctActuel, null, null, false);
      await logBotTick(kv, result);
      return result;
    }
  }

  // Règles 2 (zone basse) et 3 (zone haute) : confirmées sur 5 ticks consécutifs, en réutilisant
  // le compteur p2_oor_count/p2_oor_low et les dots déjà affichés sur la page pools (RangeBar).
  // Zone basse : seuil stocké explicitement (p2_live_range.lowTrigger), pas dérivé du prix de
  // réouverture — il se rapproche de rMin à chaque sortie basse répétée (voir Règle 2 plus bas) et
  // se réinitialise à rMin + 25% du range sur sortie haute / Règle 4 / première ouverture.
  const lowTrigger  = (hasLP && storedLowTrigger !== null)
    ? storedLowTrigger
    : (hasLP && !isNaN(rMin) && !isNaN(rMax)) ? rMin + 0.25 * (rMax - rMin) : null; // fallback si jamais stocké (1ère ouverture)
  const halfPoint   = (hasLP && !isNaN(rMin) && !isNaN(rMax)) ? rMin + 0.5  * (rMax - rMin) : null;
  const inLowZone   = lowTrigger !== null && price <= lowTrigger;
  const inHighZone  = !inLowZone && halfPoint !== null && price >= halfPoint;

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

    if (inLowZone) {
      // Règle 2 : collecte AERO (25% envoyé/75% gardé), swap vers un ratio fixe 75% WETH (plus de
      // "garder le ratio actuel" — trop proche du bord bas, ça recentrait le nouveau range de façon
      // imprévisible, cf. simulation). Range : doublé tant qu'on est sous 20% ; une fois 20% atteint,
      // on ne redouble plus (même largeur) — le seuil à range/8 (ci-dessus) suffit alors à garder
      // une marge positive après réouverture.
      const rangePctActuel = (rMax - rMin) / rMin * 100;
      const alreadyAt20    = rangePctActuel >= 20;
      const newRangePct    = alreadyAt20 ? rangePctActuel : Math.min(rangePctActuel * 2, 20);
      result.action          = 'low_zone_rebalance';
      result.lowTrigger      = parseFloat(lowTrigger.toFixed(2));
      result.rangePctActuel  = parseFloat(rangePctActuel.toFixed(2));
      result.newRangePct     = parseFloat(newRangePct.toFixed(2));
      result.collect = await runCollect(base, price, 0.75, 'low_zone_rebalance', 4, false, newRangePct, null, null, true, 'halve', lowTrigger);
      await logBotTick(kv, result);
      return result;
    }

    // Règle 3 : la zone haute est confirmée sur 5 ticks, mais l'écart de volatilité (lui) est
    // revérifié à chaque tick une fois le streak atteint — pas compté sur 5 ticks séparément.
    const pctData = await getPercentileRange();
    const p24h    = pctData && pctData.cnt >= 10 && pctData.p05 > 0
      ? (pctData.p95 - pctData.p05) / pctData.p05 * 100
      : null;
    if (p24h !== null) {
      const rangePctActuel = (rMax - rMin) / rMin * 100;
      if (Math.abs(p24h - rangePctActuel) > 1.5) {
        // Collecte AERO (50% envoyé/50% gardé), resize sans swap au range percentile24h brut,
        // garde les proportions WETH/USDC actuelles (aucun plafond/plancher de ratio).
        result.action          = 'high_half_rebalance';
        result.halfPoint       = parseFloat(halfPoint.toFixed(2));
        result.rangePctActuel  = parseFloat(rangePctActuel.toFixed(2));
        result.percentileRange = parseFloat(p24h.toFixed(2));
        result.collect = await runCollect(base, price, null, 'high_half_rebalance', 1, true, p24h, null, null, false);
        await logBotTick(kv, result);
        return result;
      }
    }
    // Zone haute confirmée mais volatilité pas encore assez divergente → on attend, compteur conservé
    result.action = 'high_zone_waiting_volatility';
    await logBotTick(kv, result);
    return result;
  }

  // Prix hors des deux zones → reset compteur
  if (oorCountRaw) { await kv.del('p2_oor_count'); await kv.del('p2_oor_low'); }

  // Règle 1c : volatilité ±1.5pt → resserrer/élargir le range (ratio dynamique MM14j × MM24h)
  // Uniquement si le total des revenus (pool + AERO + solde wallet − capital déployé) couvre
  // au moins la part AERO déjà comptée dedans — évite de resizer (et réaliser une perte) si la
  // position est globalement perdante hors farming AERO.
  const revenueGate    = hasLP ? await getRevenueGate(base) : null;
  const revenueOk      = !!revenueGate && revenueGate.totalRevenus >= revenueGate.totalAeros;
  result.revenueGate   = revenueGate;

  // Règle 1e : range bloqué au plafond 20% (la Règle 2 ne double plus, cf. alreadyAt20 plus haut)
  // alors que la volatilité 24h est redescendue très bas (≤2%, range devenu inutilement large) et
  // que la position reste gagnante sur le cycle en cours (gain ≥ 0) → resserre à 2×percentile sans
  // changer la proportion WETH/USDC actuelle (keepCurrentRatio, aucun swap forcé) et sans envoyer
  // la part AERO/fees au wallet externe ce coup-ci (tout reste dans la position/le wallet).
  if (hasLP && !isNaN(rMin) && !isNaN(rMax) && revenueGate && revenueGate.totalRevenus >= 0) {
    const rangePctActuel = (rMax - rMin) / rMin * 100;
    if (rangePctActuel >= 20) {
      const pctData = await getPercentileRange();
      const p24h    = pctData && pctData.cnt >= 10 && pctData.p05 > 0
        ? (pctData.p95 - pctData.p05) / pctData.p05 * 100
        : null;
      if (p24h !== null && p24h <= 2) {
        console.log(`[botLoop 1e] range_cap_shrink — actuel=${rangePctActuel.toFixed(2)}% p24h=${p24h.toFixed(2)}% gain=${revenueGate.totalRevenus.toFixed(2)}`);
        result.action          = 'range_cap_shrink';
        result.rangePctActuel  = parseFloat(rangePctActuel.toFixed(2));
        result.percentileRange = parseFloat(p24h.toFixed(2));
        result.newRangePct     = parseFloat((p24h * 2).toFixed(2));
        result.collect = await runCollect(base, price, null, 'range_cap_shrink', 4, true, p24h * 2, null, null, true, 'reset', null, true);
        await logBotTick(kv, result);
        return result;
      }
    }
  }

  // Règle 1f : la position en cours vient d'une sortie basse (Règle 2), a plus de 24h, et les
  // revenus cumulés depuis sa réouverture (revenueGate.totalRevenus) dépassent la perte réalisée
  // au cycle précédent (p2_prev_cycle_loss, mémorisée par la Règle 2 à sa fermeture) → on revient
  // au range percentile24h brut en gardant les proportions WETH/USDC actuelles (aucun swap forcé),
  // sans envoyer la part AERO/fees au wallet externe ce coup-ci.
  if (hasLP && !isNaN(rMin) && !isNaN(rMax) && revenueGate) {
    const openReason = await kv.get('p2_open_reason').catch(() => null);
    const ageMs       = lpState?.created_at ? Date.now() - new Date(lpState.created_at).getTime() : 0;
    if (openReason === 'low_zone_rebalance' && ageMs > 24 * 3600 * 1000) {
      const prevCycleLoss = parseFloat((await kv.get('p2_prev_cycle_loss')) ?? 0) || 0;
      if (revenueGate.totalRevenus > prevCycleLoss) {
        const pctData = await getPercentileRange();
        const p24h    = pctData && pctData.cnt >= 10 && pctData.p05 > 0
          ? (pctData.p95 - pctData.p05) / pctData.p05 * 100
          : null;
        if (p24h !== null) {
          console.log(`[botLoop 1f] low_recovery_rebalance — revenus=${revenueGate.totalRevenus.toFixed(2)} perteCycle=${prevCycleLoss.toFixed(2)} age=${(ageMs / 3600000).toFixed(1)}h`);
          result.action          = 'low_recovery_rebalance';
          result.prevCycleLoss   = parseFloat(prevCycleLoss.toFixed(2));
          result.percentileRange = parseFloat(p24h.toFixed(2));
          result.collect = await runCollect(base, price, null, 'low_recovery_rebalance', 1, true, p24h, null, null, true, 'reset', null, true);
          await logBotTick(kv, result);
          return result;
        }
      }
    }
  }

  if (RULE_1C_ENABLED && hasLP && revenueOk && !isNaN(rMin) && !isNaN(rMax)) {
    const pctData = await getPercentileRange();
    const p24h    = pctData && pctData.cnt >= 10 && pctData.p05 > 0
      ? (pctData.p95 - pctData.p05) / pctData.p05 * 100
      : null;
    if (p24h !== null) {
      const rangePctActuel = (rMax - rMin) / rMin * 100;
      const optimalRange    = p24h * 4;
      result.rangePctActuel = parseFloat(rangePctActuel.toFixed(2));
      result.optimalRange   = parseFloat(optimalRange.toFixed(2));
      if (optimalRange < rangePctActuel - 1.5) {
        console.log(`[botLoop 1c] range_shrink — actuel=${rangePctActuel.toFixed(2)}% optimal=${optimalRange.toFixed(2)}% p24h=${p24h.toFixed(2)}%`);
        result.action  = 'range_shrink_rebalance';
        result.collect = await runCollect(base, price, null, 'range_shrink_rebalance', 4, true);
        await logBotTick(kv, result);
        return result;
      } else if (optimalRange > rangePctActuel + 1.5) {
        console.log(`[botLoop 1c] range_expand — actuel=${rangePctActuel.toFixed(2)}% optimal=${optimalRange.toFixed(2)}% p24h=${p24h.toFixed(2)}%`);
        result.action  = 'range_expand_rebalance';
        result.collect = await runCollect(base, price, null, 'range_expand_rebalance', 4, true);
        await logBotTick(kv, result);
        return result;
      }
    }
  }

  // Règle 1d : changement de tendance → resserrer/élargir le range (ratio dynamique MM14j × MM24h)
  // Même garde-fou revenus que la Règle 1c. Se déclenche si le code de tendance actuel (HH/HB/BH/BB)
  // diffère de celui de l'ouverture ET est stable depuis au moins 6h (évite de réagir à un flap).
  if (RULE_1D_ENABLED && hasLP && revenueOk) {
    // Redis en priorité ; fallback DB uniquement si la clé Redis est absente/expirée
    let openTrendCode = await kv.get('p2_open_trend').catch(() => null);
    if (!openTrendCode) {
      try {
        const sqlOt = neon(process.env.DATABASE_URL);
        const rows  = await sqlOt`SELECT open_trend FROM lp_events WHERE action1 = 'CREATE_OK' AND action2 IS NULL AND COALESCE(pool_num, 2) = 2 ORDER BY id DESC LIMIT 1`;
        openTrendCode = rows[0]?.open_trend ?? null;
      } catch (_) {}
    }
    const trendChanged  = !!openTrendCode && currentTrendCode !== openTrendCode;
    const trendStable6h = (Date.now() - trendSince) >= 6 * 60 * 60 * 1000;
    result.openTrendCode = openTrendCode;
    result.trendChanged  = trendChanged;
    if (trendChanged && trendStable6h) {
      console.log(`[botLoop 1d] trend_shift — open=${openTrendCode} current=${currentTrendCode} stableMs=${Date.now() - trendSince}`);
      result.action  = 'trend_shift_rebalance';
      result.collect = await runCollect(base, price, reopenRatio, 'trend_shift_rebalance');
      await logBotTick(kv, result);
      return result;
    }
  }

  // Règle 2 : aucune position → auto-start
  if (!hasLP) {
    // Vérifier si Redis est désynchronisé (position active en DB, Redis dit CLOSE_OK)
    try {
      const sqlCheck = neon(process.env.DATABASE_URL);
      const dbRows = await sqlCheck`
        SELECT * FROM lp_events
        WHERE action1 = 'CREATE_OK' AND action2 IS NULL AND token_id IS NOT NULL
          AND COALESCE(pool_num, 2) = ${ALGO_CONFIG.POOL_NUM}
        ORDER BY id DESC LIMIT 1
      `;
      if (dbRows[0]?.token_id) {
        await writeLpState(ALGO_CONFIG.POOL_NUM, dbRows[0]);
        result.action = 'redis_restored';
        await logBotTick(kv, result);
        return result;
      }
    } catch (_) {}

    // Spread check : marché trop agité → attendre (appliqué quel que soit le côté de sortie Règle 1A)
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

    // Nouvelle Règle 1 : aucune position → ouvrir au range percentile24h brut (×1), 50/50 WETH/USDC.
    // Sauf si une réouverture a été retardée par le spread check (Règles 2/3/4) : on reprend alors
    // exactement ses paramètres (ratio, largeur, trigger) au lieu de repartir de zéro.
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
        await saveRangeAndLowTrigger(result, price, pending.lowTriggerMode ?? 'reset', pending.oldLowTrigger ?? null);
        await kv.del('p2_pending_reopen').catch(() => {});
        await kv.set('p2_open_reason', pending.closeReason ?? 'auto_start', { ex: 30 * 86400 }).catch(() => {});
      }
    } else {
      result.autoStart = await autoStart({ base, price, targetRatio: 0.5, rangeMultiplier: 1 });
      if (!result.autoStart.skipped && !result.autoStart.error) {
        await kv.set('p2_open_reason', 'auto_start', { ex: 30 * 86400 }).catch(() => {});
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
