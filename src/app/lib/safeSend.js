import { ethers } from "ethers";

// Envoi de transaction qui ne peut jamais produire deux transactions pour une même intention
// (incident du 29/10 : complément gas fait deux fois). Garanties :
//  - le nonce est figé avant le premier envoi et réutilisé par tous les retries : au plus UNE des
//    transactions signées peut être minée (un retry de frais REMPLACE, il ne s'ajoute pas) ;
//  - la tx est signée avant diffusion, donc son hash est connu : au moindre doute après un envoi,
//    on cherche ce hash on-chain et on reprend cette tx au lieu d'en créer une autre ;
//  - un cas ambigu (erreur après diffusion, "nonce too low"/"already known" après un de nos envois)
//    lève une erreur AMBIGUOUS_SEND : l'appelant ne doit JAMAIS renvoyer, il relit l'état réel.
export const AMBIGUOUS_SEND = "AMBIGUOUS_SEND";
export const isAmbiguousSend = (e) => e?.code === AMBIGUOUS_SEND;

const FEE_RE    = /replacement fee too low|replacement transaction underpriced|transaction underpriced|max fee per gas less than block base fee/i;
const STALE_RE  = /nonce too low|nonce has already been used|nonce already/i;
const KNOWN_RE  = /already known|known transaction|already imported/i;
const NET_RE    = /server response [45]\d\d|network error|econnreset|etimedout|socket hang|429|rate limit|compute units|timeout|fetch failed|failed to fetch/i;
const REJECT_RE = /insufficient funds|intrinsic gas|exceeds block gas limit|invalid sender|invalid signature/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => `${e?.shortMessage ?? ""} ${e?.message ?? ""} ${e?.error?.message ?? ""}`.toLowerCase();

async function findOnChain(provider, hashes) {
  for (const h of hashes) {
    try { const t = await provider.getTransaction(h); if (t) return t; } catch (_) {}
  }
  return null;
}

function ambiguous(hashes, cause) {
  return Object.assign(
    new Error(`envoi ambigu, jamais renvoyé automatiquement (hashes: ${hashes.join(",") || "aucun"}) : ${cause}`),
    { code: AMBIGUOUS_SEND, hashes },
  );
}

export async function safeSend(wallet, params) {
  const provider = wallet.provider;
  if (wallet._nextNonce == null) {
    wallet._nextNonce = await provider.getTransactionCount(wallet.address, "pending");
  }
  let nonce = params.nonce ?? wallet._nextNonce;
  let p = { ...params };
  delete p.nonce;
  let hashes = [];
  let signed = null;
  let resynced = false;
  let lastErr = "";

  for (let attempt = 0; attempt < 5; attempt++) {
    if (!signed) {
      // Rien n'est encore parti ici : une erreur (ex. estimation de gas qui revert) est sans risque.
      try {
        const populated = await wallet.populateTransaction({ ...p, nonce });
        signed = await wallet.signTransaction(populated);
        hashes.push(ethers.Transaction.from(signed).hash);
      } catch (e) {
        if (attempt < 3 && NET_RE.test(errText(e)) && hashes.length === 0) { await sleep(2000); continue; }
        throw e;
      }
    }
    try {
      const resp = await provider.broadcastTransaction(signed);
      wallet._nextNonce = nonce + 1;
      return resp;
    } catch (e) {
      const msg = errText(e);
      lastErr = e?.shortMessage ?? e?.message ?? String(e);

      const found = await findOnChain(provider, hashes);
      if (found) { wallet._nextNonce = nonce + 1; return found; }

      if (FEE_RE.test(msg)) {
        // Même nonce, frais plus élevés : remplace la tx en attente, ne s'ajoute pas.
        const feeData = await provider.getFeeData();
        p = {
          ...p,
          maxFeePerGas:         (feeData.maxFeePerGas         ?? 2000000000n) * 125n / 100n,
          maxPriorityFeePerGas: (feeData.maxPriorityFeePerGas ?? 1000000n)   * 125n / 100n,
        };
        delete p.gasPrice;
        signed = null;
        await sleep(1500);
        continue;
      }

      if (STALE_RE.test(msg) && attempt === 0 && !resynced && hashes.length === 1) {
        // Premier envoi de cet appel refusé : le suivi de nonce était périmé (tx hors de ce compteur).
        // Aucune tx de cet appel n'a été diffusée, donc resynchroniser ne peut pas créer de doublon.
        resynced = true;
        nonce = await provider.getTransactionCount(wallet.address, "pending");
        wallet._nextNonce = nonce;
        hashes = [];
        signed = null;
        await sleep(1000);
        continue;
      }

      if (STALE_RE.test(msg) || KNOWN_RE.test(msg)) {
        // Le nonce est consommé ou la tx est déjà connue alors qu'on a déjà diffusé : c'est très
        // probablement la nôtre. Laisse un instant au nœud puis cherche-la ; sinon on s'arrête.
        await sleep(2500);
        const again = await findOnChain(provider, hashes);
        if (again) { wallet._nextNonce = nonce + 1; return again; }
        wallet._nextNonce = null;
        throw ambiguous(hashes, lastErr);
      }

      if (NET_RE.test(msg)) {
        // Même tx signée, rediffusée telle quelle (mêmes octets, même hash) : idempotent.
        await sleep(3000);
        continue;
      }

      if (REJECT_RE.test(msg)) throw e; // refus net du nœud, rien n'est parti

      wallet._nextNonce = null;
      throw ambiguous(hashes, lastErr);
    }
  }
  wallet._nextNonce = null;
  throw ambiguous(hashes, lastErr || "tentatives épuisées");
}
