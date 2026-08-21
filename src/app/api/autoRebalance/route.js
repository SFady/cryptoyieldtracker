import { ethers } from "ethers";
import { neon } from "@neondatabase/serverless";
import { getLastTwoPrices, getPercentileRange, readLpState, writeLpState, wasCollectedToday, readErrorState, writeErrorState, readCollectErr, writeCollectErr, checkRedisLock, acquireRedisLock } from "../../lib/cronKv";
import { POOL_ADDRESS, getPoolAddress } from "../../lib/config";

export const runtime     = "nodejs";
export const maxDuration = 300;

const RANGE_COEFF_2 = 4;   // multiplicateur range pool 2
const RANGE_COEFF_3 = 1;   // multiplicateur range pool 3

const sql = neon(process.env.DATABASE_URL);

const RPC_URLS = [
  process.env.ALCHEMY_RPC_URL,
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
].filter(Boolean);

async function getPoolWethPrice(fallback) {
  for (const url of RPC_URLS) {
    try {
      const res = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: POOL_ADDRESS, data: "0x3850c7bd" }, "latest"] }),
        signal:  AbortSignal.timeout(6000),
      });
      const json = await res.json();
      if (json.result && json.result !== "0x") {
        const sqrtPriceX96 = BigInt("0x" + json.result.slice(2, 66));
        const sqrtP = Number(sqrtPriceX96) / Number(2n ** 96n);
        const price = sqrtP * sqrtP * 1e12;
        if (price > 100 && price < 100000) return price;
      }
    } catch (_) {}
  }
  return fallback;
}

async function sendErrorEmail(subject, body) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body:    JSON.stringify({
        from:    "onboarding@resend.dev",
        to:      "sylvain.fady@gmail.com",
        subject,
        html:    `<pre style="font-family:monospace">${body}</pre>`,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (_) {}
}

// Redis en priorité, fallback DB si cache vide — réécrit dans Redis pour rafraîchir le TTL
async function getPositionState(poolNum) {
  const cached = await readLpState(poolNum);
  if (cached) return cached;
  const rows = await sql`
    SELECT usdc_placed, range_pct, range_min, range_max, action2, created_at, usdc_remaining, token_id
    FROM lp_events
    WHERE action1 = 'CREATE_OK' AND COALESCE(pool_num, 2) = ${poolNum}
    ORDER BY id DESC LIMIT 1
  `;
  const state = rows[0] ?? null;
  if (state) await writeLpState(poolNum, state);
  return state;
}

async function handleRequest(forceCase, poolNum = 2, overrideTokenId = null, noTransfer = false) {
  if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10].includes(forceCase))
    return Response.json({ skipped: true, reason: `Cas ${forceCase} non implémenté` });


  // Cases de recovery / fermeture — bypass des checks lock/erreur
  if (forceCase === 7)  return handleCase7(poolNum, overrideTokenId);
  if (forceCase === 8)  return handleCase8(poolNum);
  if (forceCase === 9)  return handleCase9(poolNum, noTransfer);
  if (forceCase === 10) return handleCase10(poolNum);

  // Helper timeout — si Redis pend, continuer avec la valeur par défaut
  const withRedisTimeout = (p, ms, def) => Promise.race([p.catch(() => def), new Promise(r => setTimeout(() => r(def), ms))]);

  // 1. Vérifier si une exécution est déjà active (lock Redis — timeout 4s, défaut = pas de lock)
  const isLocked = await withRedisTimeout(checkRedisLock(), 4000, false);
  if (isLocked)
    return Response.json({ error: `Exécution déjà en cours — réessayer dans 5 min` }, { status: 409 });

  // 2. Vérifier l'absence d'erreur (Redis → DB, timeout 4s — si Redis mort on passe)
  try {
    const cached = await withRedisTimeout(readErrorState(poolNum), 4000, null);
    if (cached !== null) {
      if (cached.hasError)
        return Response.json({ error: `Bloqué — erreur détectée : ${cached.msg ?? "ERR"}` }, { status: 409 });
    } else {
      const errRows = await sql`
        SELECT action1, action2, error_msg FROM lp_events
        WHERE action1 != 'RUNNING'
          AND COALESCE(pool_num, 2) = ${poolNum}
        ORDER BY id DESC LIMIT 1
      `;
      if (errRows.length > 0) {
        const { action1, action2, error_msg } = errRows[0];
        const hasError = action1 !== "FEE_COLLECT" && ((action1 && action1.includes("ERR")) || (action2 && action2.includes("ERR")));
        await withRedisTimeout(writeErrorState(poolNum, hasError, error_msg ?? null), 3000, null);
        if (hasError)
          return Response.json({ error: `Bloqué — erreur détectée en base : ${error_msg ?? action1}` }, { status: 409 });
      } else {
        await withRedisTimeout(writeErrorState(poolNum, false), 3000, null);
      }
    }
  } catch (e) {
    return Response.json({ error: `Error check échoué : ${e.message}` }, { status: 500 });
  }

  // 3. Déléguer au cas — le lock est acquis à l'intérieur, après les vérifications de conditions
  if (forceCase === 1) return handleCase1(poolNum);
  if (forceCase === 2) return handleCase2(poolNum);
  if (forceCase === 3) return handleCase3(poolNum);
  if (forceCase === 4) return handleCase4(poolNum);
  if (forceCase === 5) return handleCase5(poolNum);
  if (forceCase === 6) return handleCase6(poolNum);
}

export async function GET(req) {
  const p = new URL(req.url).searchParams;
  const forceCase   = parseInt(p.get("case")    ?? "0");
  const poolNum     = parseInt(p.get("poolNum") ?? "2");
  const noTransfer  = p.get("noTransfer") === "true";
  return handleRequest(forceCase, poolNum, null, noTransfer);
}

export async function POST(req) {
  const { forceCase, poolNum, overrideTokenId } = await req.json().catch(() => ({}));
  return handleRequest(forceCase, poolNum ?? 2, overrideTokenId ?? null);
}

async function handleCase1(poolNum = 2) {
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  if (!base) return Response.json({ error: "APP_URL non configuré" }, { status: 500 });

  // 1. Prix WETH on-chain
  const livePrice = await getPoolWethPrice(0);
  if (!livePrice || livePrice < 100 || livePrice > 100000)
    return Response.json({ skipped: true, reason: `Prix WETH on-chain invalide : ${livePrice}` });

  // 2. Vérifier position ouverte (Redis → DB)
  let lastPos;
  try {
    const state = await getPositionState(poolNum);
    if (!state || state.action2 !== null)
      return Response.json({ skipped: true, reason: "Aucune position ouverte en DB" });
    lastPos = state;
  } catch (e) {
    return Response.json({ error: `DB check failed: ${e.message}` }, { status: 500 });
  }

  const usdcPlaced = parseFloat(lastPos.usdc_placed);
  const rangePct   = parseFloat(lastPos.range_pct);
  const rangeMin   = parseFloat(lastPos.range_min);
  if (!usdcPlaced || isNaN(usdcPlaced) || !rangePct || isNaN(rangePct))
    return Response.json({ skipped: true, reason: "Données position invalides en DB" });

  try {
    const cnt = await sql`
      SELECT COUNT(*)::int AS n FROM lp_events
      WHERE action1 = 'CREATE_OK' AND COALESCE(pool_num, 2) = ${poolNum}
        AND created_at > NOW() - INTERVAL '24 hours'
    `;
    if (cnt[0].n >= 4)
      return Response.json({ skipped: true, reason: `4 rebalances déjà effectués dans les 24h (pool ${poolNum})` });
  } catch (e) {
    return Response.json({ error: `DB check failed: ${e.message}` }, { status: 500 });
  }

  if (!isNaN(rangeMin) && livePrice >= rangeMin)
    return Response.json({ skipped: true, reason: `Prix WETH $${livePrice.toFixed(2)} >= borne basse $${rangeMin} — pas hors range bas` });

  // Confirmation : les 2 derniers prix cron doivent être sous la borne basse
  {
    const cronPrices = await getLastTwoPrices();
    if (cronPrices.length < 2 || cronPrices.some(p => p >= rangeMin))
      return Response.json({ skipped: true, reason: `Confirmation insuffisante — les 2 derniers prix cron (${cronPrices.map(p => '$' + p.toFixed(0)).join(', ')}) doivent être sous $${rangeMin}` });
  }

  let newRangePct = 2;
  try {
    const pct = await getPercentileRange();
    if (pct && pct.cnt >= 10 && pct.p05 > 0)
      newRangePct = Math.max(2, ((pct.p95 - pct.p05) / pct.p05) * 100);
  } catch (_) {}
  newRangePct = parseFloat((newRangePct * (poolNum === 3 ? RANGE_COEFF_3 : RANGE_COEFF_2)).toFixed(2));

  const sqrtRatio    = Math.sqrt(1 + newRangePct / 100);
  const liveMinPrice = livePrice / sqrtRatio;
  const liveMaxPrice = livePrice * sqrtRatio;

  // 3. Toutes les conditions sont remplies → acquérir le lock
  let release;
  release = await acquireRedisLock();
  if (!release) return Response.json({ error: `Exécution déjà en cours — réessayer dans 5 min` }, { status: 409 });

  try {
    // 4. Fermer la position — garder le WETH en wallet, envoyer fees USDC+AERO vers destination
    let closeData;
    try {
      const res = await fetch(`${base}/api/closePositions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keepWeth: true, halfFees: true, poolNum, caseNum: 1 }),
        signal: AbortSignal.timeout(200000),
      });
      closeData = await res.json();
      if (!res.ok) throw new Error(typeof closeData?.error === "string" ? closeData.error : JSON.stringify(closeData?.error ?? "close failed"));
      if (!closeData.collected?.length) throw new Error(`closePositions n'a rien collecté — position introuvable dans le gauge (tokenId=${lastPos.token_id})`);
    } catch (e) { throw new Error(`closePositions failed: ${e?.message ?? String(e)}`); }

    // 4b. Fermer toutes les positions Hyperliquid (pool 2 uniquement)
    if (poolNum === 2) {
      try {
        const hlRes  = await fetch(`${base}/api/hyperliquid-cancel-all`, {
          method: "POST",
          signal: AbortSignal.timeout(30000),
        });
        const hlData = await hlRes.json();
        if (!hlRes.ok) throw new Error(typeof hlData?.error === "string" ? hlData.error : JSON.stringify(hlData));
      } catch (e) { throw new Error(`hyperliquid-cancel-all failed: ${e?.message ?? String(e)}`); }
    }

    // 5. Créer nouvelle position 50% WETH / 50% USDC
    const res = await fetch(`${base}/api/createPosition`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountUSDC: 999999, minPrice: liveMinPrice, maxPrice: liveMaxPrice, currentPrice: livePrice, targetRatio: 0.5, poolNum, caseNum: 1 }),
      signal: AbortSignal.timeout(90000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : JSON.stringify(data?.error ?? "createPosition failed"));

    await release();
    return Response.json({ ok: true, case: 1, newRangePct, livePrice, minPrice: liveMinPrice.toFixed(0), maxPrice: liveMaxPrice.toFixed(0), createResult: data });
  } catch (e) {
    await release();
    const msg = e?.message ?? String(e);
    await sendErrorEmail("[CryptoYieldTracker] Erreur — Cas 1", `Prix ETH : $${livePrice}\n\nErreur : ${msg}`);
    return Response.json({ case: 1, error: msg }, { status: 500 });
  }
}

async function handleCase2(poolNum = 2) {
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  if (!base) return Response.json({ error: "APP_URL non configuré" }, { status: 500 });

  // 1. Prix WETH on-chain
  const livePrice = await getPoolWethPrice(0);
  if (!livePrice || livePrice < 100 || livePrice > 100000)
    return Response.json({ skipped: true, reason: `Prix WETH on-chain invalide : ${livePrice}` });

  // 2. Vérifier position ouverte (Redis → DB)
  let lastPos;
  try {
    const state = await getPositionState(poolNum);
    if (!state || state.action2 !== null)
      return Response.json({ skipped: true, reason: "Aucune position ouverte en DB" });
    lastPos = state;
  } catch (e) {
    return Response.json({ error: `DB check failed: ${e.message}` }, { status: 500 });
  }

  const usdcPlaced = parseFloat(lastPos.usdc_placed);
  const rangePct   = parseFloat(lastPos.range_pct);
  const rangeMax   = parseFloat(lastPos.range_max);
  if (!usdcPlaced || isNaN(usdcPlaced) || !rangePct || isNaN(rangePct))
    return Response.json({ skipped: true, reason: "Données position invalides en DB" });

  try {
    const cnt = await sql`
      SELECT COUNT(*)::int AS n FROM lp_events
      WHERE action1 = 'CREATE_OK' AND COALESCE(pool_num, 2) = ${poolNum}
        AND created_at > NOW() - INTERVAL '24 hours'
    `;
    if (cnt[0].n >= 4)
      return Response.json({ skipped: true, reason: `4 rebalances déjà effectués dans les 24h (pool ${poolNum})` });
  } catch (e) {
    return Response.json({ error: `DB check failed: ${e.message}` }, { status: 500 });
  }

  if (!isNaN(rangeMax) && livePrice <= rangeMax)
    return Response.json({ skipped: true, reason: `Prix WETH $${livePrice.toFixed(2)} <= borne haute $${rangeMax} — pas hors range haut` });

  // Confirmation : les 2 derniers prix cron doivent être au-dessus de la borne haute
  {
    const cronPrices = await getLastTwoPrices();
    if (cronPrices.length < 2 || cronPrices.some(p => p <= rangeMax))
      return Response.json({ skipped: true, reason: `Confirmation insuffisante — les 2 derniers prix cron (${cronPrices.map(p => '$' + p.toFixed(0)).join(', ')}) doivent être au-dessus de $${rangeMax}` });
  }

  let newRangePct = 2;
  try {
    const pct = await getPercentileRange();
    if (pct && pct.cnt >= 10 && pct.p05 > 0)
      newRangePct = Math.max(2, ((pct.p95 - pct.p05) / pct.p05) * 100);
  } catch (_) {}
  newRangePct = parseFloat((newRangePct * (poolNum === 3 ? RANGE_COEFF_3 : RANGE_COEFF_2)).toFixed(2));

  const sqrtRatio    = Math.sqrt(1 + newRangePct / 100);
  const liveMinPrice = livePrice / sqrtRatio;
  const liveMaxPrice = livePrice * sqrtRatio;

  // 3. Toutes les conditions sont remplies → acquérir le lock
  let release;
  release = await acquireRedisLock();
  if (!release) return Response.json({ error: `Exécution déjà en cours — réessayer dans 5 min` }, { status: 409 });

  try {
    // 4. Fermer la position — garder le WETH en wallet, envoyer fees USDC+AERO vers destination
    let closeData;
    try {
      const res = await fetch(`${base}/api/closePositions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keepWeth: true, halfFees: true, poolNum, caseNum: 2 }),
        signal: AbortSignal.timeout(200000),
      });
      closeData = await res.json();
      if (!res.ok) throw new Error(typeof closeData?.error === "string" ? closeData.error : JSON.stringify(closeData?.error ?? "close failed"));
      if (!closeData.collected?.length) throw new Error(`closePositions n'a rien collecté — position introuvable dans le gauge (tokenId=${lastPos.token_id})`);
    } catch (e) { throw new Error(`closePositions failed: ${e?.message ?? String(e)}`); }

    // 4b. Fermer toutes les positions Hyperliquid (pool 2 uniquement)
    if (poolNum === 2) {
      try {
        const hlRes  = await fetch(`${base}/api/hyperliquid-cancel-all`, {
          method: "POST",
          signal: AbortSignal.timeout(30000),
        });
        const hlData = await hlRes.json();
        if (!hlRes.ok) throw new Error(typeof hlData?.error === "string" ? hlData.error : JSON.stringify(hlData));
      } catch (e) { throw new Error(`hyperliquid-cancel-all failed: ${e?.message ?? String(e)}`); }
    }

    // 5. Créer nouvelle position 50/50
    const res = await fetch(`${base}/api/createPosition`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountUSDC: 999999, minPrice: liveMinPrice, maxPrice: liveMaxPrice, currentPrice: livePrice, targetRatio: 0.5, poolNum, caseNum: 2 }),
      signal: AbortSignal.timeout(90000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : JSON.stringify(data?.error ?? "createPosition failed"));

    await release();
    return Response.json({ ok: true, case: 2, newRangePct, livePrice, minPrice: liveMinPrice.toFixed(0), maxPrice: liveMaxPrice.toFixed(0), createResult: data });
  } catch (e) {
    await release();
    const msg = e?.message ?? String(e);
    await sendErrorEmail("[CryptoYieldTracker] Erreur — Cas 2", `Prix ETH : $${livePrice}\n\nErreur : ${msg}`);
    return Response.json({ case: 2, error: msg }, { status: 500 });
  }
}

async function handleCase3(poolNum = 2) {
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  if (!base) return Response.json({ error: "APP_URL non configuré" }, { status: 500 });

  // 1. Prix WETH on-chain
  const livePrice = await getPoolWethPrice(0);
  if (!livePrice || livePrice < 100 || livePrice > 100000)
    return Response.json({ skipped: true, reason: `Prix WETH on-chain invalide : ${livePrice}` });

  // 2. Vérifier position ouverte (Redis → DB)
  let lastPos;
  try {
    const state = await getPositionState(poolNum);
    if (!state || state.action2 !== null)
      return Response.json({ skipped: true, reason: "Aucune position ouverte en DB" });
    lastPos = state;
  } catch (e) {
    return Response.json({ error: `DB check failed: ${e.message}` }, { status: 500 });
  }

  const usdcPlaced    = parseFloat(lastPos.usdc_placed);
  const rangePct = parseFloat(lastPos.range_pct);
  const rangeMin = parseFloat(lastPos.range_min);
  const rangeMax = parseFloat(lastPos.range_max);
  if (!usdcPlaced || isNaN(usdcPlaced) || !rangePct || isNaN(rangePct))
    return Response.json({ skipped: true, reason: "Données position invalides en DB" });

  // 3. Vérifier que le prix est IN range
  if (!isNaN(rangeMin) && !isNaN(rangeMax) && (livePrice < rangeMin || livePrice > rangeMax))
    return Response.json({ skipped: true, reason: `Prix WETH $${livePrice.toFixed(2)} hors range [$${rangeMin}–$${rangeMax}] — cas 1 ou 2 approprié` });

  // 4. Vérifier que la position est ouverte depuis > 12h
  const openedAt  = new Date(lastPos.created_at);
  const ageHours  = (Date.now() - openedAt.getTime()) / 3_600_000;
  if (ageHours < 6)
    return Response.json({ skipped: true, reason: `Position ouverte depuis ${ageHours.toFixed(1)}h — attendre 6h minimum` });

  // 5. Calculer le range via percentiles 24h
  let newRangePct = 2;
  try {
    const pct = await getPercentileRange();
    if (pct && pct.cnt >= 10 && pct.p05 > 0)
      newRangePct = Math.max(2, ((pct.p95 - pct.p05) / pct.p05) * 100);
  } catch (_) {}
  newRangePct = parseFloat((newRangePct * (poolNum === 3 ? RANGE_COEFF_3 : RANGE_COEFF_2)).toFixed(2));

  // 6. Rebalancer si le range actuel de la position est > 1.5x le nouveau range (percentile)
  const actualRangePct = (!isNaN(rangeMin) && !isNaN(rangeMax) && rangeMin > 0)
    ? parseFloat(((rangeMax / rangeMin - 1) * 100).toFixed(2))
    : rangePct;
  if (actualRangePct - newRangePct < 1)
    return Response.json({ skipped: true, reason: `Écart range ${(actualRangePct - newRangePct).toFixed(2)}% insuffisant — seuil : ≥ 1% (actuel ${actualRangePct}% vs nouveau ${newRangePct}%)` });

  const sqrtRatio    = Math.sqrt(1 + newRangePct / 100);
  const liveMinPrice = livePrice / sqrtRatio;
  const liveMaxPrice = livePrice * sqrtRatio;

  // 7. Toutes les conditions sont remplies → acquérir le lock
  let release;
  release = await acquireRedisLock();
  if (!release) return Response.json({ error: `Exécution déjà en cours — réessayer dans 5 min` }, { status: 409 });

  try {
    // 7. Fermer la position — garder le WETH en wallet, envoyer fees USDC+AERO vers destination
    let closeData;
    try {
      const res = await fetch(`${base}/api/closePositions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keepWeth: true, threeQuarterFees: true, poolNum, caseNum: 3 }),
        signal: AbortSignal.timeout(200000),
      });
      closeData = await res.json();
      if (!res.ok) throw new Error(typeof closeData?.error === "string" ? closeData.error : JSON.stringify(closeData?.error ?? "close failed"));
      if (!closeData.collected?.length) throw new Error(`closePositions n'a rien collecté — position introuvable dans le gauge (tokenId=${lastPos.token_id})`);
    } catch (e) { throw new Error(`closePositions failed: ${e?.message ?? String(e)}`); }

    // 7b. Fermer toutes les positions Hyperliquid (pool 2 uniquement)
    if (poolNum === 2) {
      try {
        const hlRes  = await fetch(`${base}/api/hyperliquid-cancel-all`, {
          method: "POST",
          signal: AbortSignal.timeout(30000),
        });
        const hlData = await hlRes.json();
        if (!hlRes.ok) throw new Error(typeof hlData?.error === "string" ? hlData.error : JSON.stringify(hlData));
      } catch (e) { throw new Error(`hyperliquid-cancel-all failed: ${e?.message ?? String(e)}`); }
    }

    // 8. Créer nouvelle position 50/50
    const res = await fetch(`${base}/api/createPosition`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountUSDC: 999999, minPrice: liveMinPrice, maxPrice: liveMaxPrice, currentPrice: livePrice, targetRatio: 0.5, poolNum, caseNum: 3 }),
      signal: AbortSignal.timeout(90000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : JSON.stringify(data?.error ?? "createPosition failed"));

    await release();
    return Response.json({ ok: true, case: 3, ageHours: ageHours.toFixed(1), newRangePct, livePrice, minPrice: liveMinPrice.toFixed(0), maxPrice: liveMaxPrice.toFixed(0), createResult: data });
  } catch (e) {
    await release();
    const msg = e?.message ?? String(e);
    await sendErrorEmail("[CryptoYieldTracker] Erreur — Cas 3", `Prix ETH : $${livePrice}\n\nErreur : ${msg}`);
    return Response.json({ case: 3, error: msg }, { status: 500 });
  }
}

async function handleCase5(poolNum = 2) {
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  if (!base) return Response.json({ error: "APP_URL non configuré" }, { status: 500 });

  // 1. Vérifier heure française strictement entre 7h00 et 7h59
  const _now    = new Date();
  const frHour  = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", hour: "numeric", hour12: false }).format(_now), 10);
  const frMin   = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", minute: "numeric" }).format(_now), 10);
  const frTotal = frHour * 60 + frMin;
  if (frTotal < 7 * 60 || frTotal >= 8 * 60)
    return Response.json({ skipped: true, reason: `Hors fenêtre 7h-8h France — heure actuelle : ${frHour}h${String(frMin).padStart(2, "0")}` });

  // 2. Vérifier position ouverte (Redis → DB)
  try {
    const state = await getPositionState(poolNum);
    if (!state || state.action2 !== null)
      return Response.json({ skipped: true, reason: "Aucune position ouverte en DB" });
  } catch (e) {
    return Response.json({ error: `DB check failed: ${e.message}` }, { status: 500 });
  }

  // 3. Vérifier FEE_COLLECT : COLLECT_ERR ou déjà collecté aujourd'hui
  try {
    const cachedErr = await readCollectErr(poolNum);
    if (cachedErr === true)
      return Response.json({ skipped: true, reason: "Dernier FEE_COLLECT en erreur — résoudre avant de relancer" });
    if (cachedErr === null) {
      const lastCollect = await sql`
        SELECT action2 FROM lp_events
        WHERE action1 = 'FEE_COLLECT'
          AND COALESCE(pool_num, 2) = ${poolNum}
        ORDER BY id DESC LIMIT 1
      `;
      const isCollectErr = lastCollect.length > 0 && lastCollect[0].action2 === 'COLLECT_ERR';
      await writeCollectErr(poolNum, isCollectErr);
      if (isCollectErr)
        return Response.json({ skipped: true, reason: "Dernier FEE_COLLECT en erreur — résoudre avant de relancer" });
    }

    if (await wasCollectedToday(poolNum))
      return Response.json({ skipped: true, reason: "Fees déjà collectées aujourd'hui" });
  } catch (e) {
    return Response.json({ error: `DB check failed: ${e.message}` }, { status: 500 });
  }

  // 4. Appeler collectFees
  try {
    const res = await fetch(`${base}/api/collectFees`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ poolNum, caseNum: 5 }),
      signal: AbortSignal.timeout(180000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : JSON.stringify(data?.error ?? "collectFees failed"));
    return Response.json({ ok: true, case: 5, ...data });
  } catch (e) {
    const msg = e?.message ?? String(e);
    await sendErrorEmail("[CryptoYieldTracker] Erreur — Cas 5 (collect fees)", `Erreur : ${msg}`);
    return Response.json({ case: 5, error: msg }, { status: 500 });
  }
}

async function handleCase6(poolNum = 2) {
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  if (!base) return Response.json({ error: "APP_URL non configuré" }, { status: 500 });

  // Vérifier position ouverte (Redis → DB)
  try {
    const state = await getPositionState(poolNum);
    if (!state || state.action2 !== null)
      return Response.json({ skipped: true, reason: "Aucune position ouverte en DB" });
  } catch (e) {
    return Response.json({ error: `DB check failed: ${e.message}` }, { status: 500 });
  }

  // Vérifier COLLECT_ERR non résolu (Redis → DB)
  try {
    const cachedErr = await readCollectErr(poolNum);
    if (cachedErr === true)
      return Response.json({ skipped: true, reason: "Dernier FEE_COLLECT en erreur — résoudre avant de relancer" });
    if (cachedErr === null) {
      const lastCollect = await sql`
        SELECT action2 FROM lp_events
        WHERE action1 = 'FEE_COLLECT'
          AND COALESCE(pool_num, 2) = ${poolNum}
        ORDER BY id DESC LIMIT 1
      `;
      const isCollectErr = lastCollect.length > 0 && lastCollect[0].action2 === 'COLLECT_ERR';
      await writeCollectErr(poolNum, isCollectErr);
      if (isCollectErr)
        return Response.json({ skipped: true, reason: "Dernier FEE_COLLECT en erreur — résoudre avant de relancer" });
    }
  } catch (e) {
    return Response.json({ error: `DB check failed: ${e.message}` }, { status: 500 });
  }

  try {
    const res = await fetch(`${base}/api/collectFees`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ poolNum, caseNum: 6, noTransfer: poolNum === 2 }),
      signal: AbortSignal.timeout(180000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : JSON.stringify(data?.error ?? "collectFees failed"));
    return Response.json({ ok: true, case: 6, ...data });
  } catch (e) {
    const msg = e?.message ?? String(e);
    await sendErrorEmail("[CryptoYieldTracker] Erreur — Cas 6 (collect fees manuel)", `Erreur : ${msg}`);
    return Response.json({ case: 6, error: msg }, { status: 500 });
  }
}

async function handleCase8(poolNum = 2) {
  // Timeout sur chaque écriture Redis — si Upstash pend, on continue quand même
  const withTimeout = (p, ms = 4000) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);
  const results = await Promise.allSettled([
    withTimeout(writeCollectErr(poolNum, false)),
    withTimeout(writeErrorState(poolNum, false)),
    withTimeout(writeLpState(poolNum, { action1: "CREATE_OK", action2: "CLOSE_OK" })),
  ]);
  const failed = results.filter(r => r.status === "rejected").length;
  return Response.json({ ok: true, msg: `Erreurs réinitialisées pour pool ${poolNum}${failed ? ` (${failed} écriture(s) Redis timeout — retente dans 1 min)` : ""}` });
}

async function enrichAndSaveLpState(provider, NFPM, NFPM_IFACE, tokenIdBig, rawId, poolNum) {
  let lpData = { action1: "CREATE_OK", action2: null, token_id: rawId, created_at: new Date().toISOString() };
  // 1. Données de range depuis le dernier CREATE_OK en DB
  try {
    const rows = await sql`
      SELECT usdc_placed, range_pct, range_min, range_max, usdc_remaining
      FROM lp_events WHERE action1 = 'CREATE_OK' AND COALESCE(pool_num, 2) = ${poolNum}
      ORDER BY id DESC LIMIT 1
    `;
    if (rows[0]) lpData = { ...lpData, ...rows[0] };
  } catch (_) {}
  // 2. Si range toujours manquante, lire les ticks on-chain
  if (!lpData.range_min || !lpData.range_pct) {
    try {
      const posHex = await provider.call({ to: NFPM, data: NFPM_IFACE.encodeFunctionData("positions", [tokenIdBig]) });
      const pos = NFPM_IFACE.decodeFunctionResult("positions", posHex);
      const tickToPrice = t => Math.pow(1.0001, Number(t)) * 1e12;
      const rMin = tickToPrice(pos.tickLower);
      const rMax = tickToPrice(pos.tickUpper);
      lpData.range_min  = rMin;
      lpData.range_max  = rMax;
      lpData.range_pct  = parseFloat(((rMax / rMin - 1) * 100).toFixed(2));
      if (!lpData.usdc_placed) lpData.usdc_placed = 300; // valeur par défaut — le vrai budget vient du wallet
    } catch (_) {}
  }
  await writeLpState(poolNum, lpData);
}

async function findStakedViaGauge(gaugeAddr, wallet, poolNum) {
  try {
    const GAUGE_EXT = new ethers.Interface(["function stakedValues(address depositor) view returns (uint256[])"]);
    const h = await wallet.provider.call({ to: gaugeAddr, data: GAUGE_EXT.encodeFunctionData("stakedValues", [wallet.address]) });
    const [ids] = GAUGE_EXT.decodeFunctionResult("stakedValues", h);
    if (!ids || ids.length === 0) return null;
    const stId = ids[0];
    const raw  = stId.toString();
    // Enrichir avec les données de range du dernier CREATE_OK pour que les cas 1/2/3 aient usdc_placed/range_pct/range_min/range_max
    let lpData = { action1: "CREATE_OK", action2: null, token_id: raw, created_at: new Date().toISOString() };
    try {
      const rows = await sql`
        SELECT usdc_placed, range_pct, range_min, range_max, usdc_remaining
        FROM lp_events
        WHERE action1 = 'CREATE_OK' AND COALESCE(pool_num, 2) = ${poolNum}
        ORDER BY id DESC LIMIT 1
      `;
      if (rows[0]) lpData = { ...lpData, ...rows[0] };
    } catch (_) {}
    await writeErrorState(poolNum, false);
    await writeLpState(poolNum, lpData);
    return Response.json({ ok: true, msg: `NFT #${raw} trouvé staké dans le gauge via stakedValues — erreur et lpState réinitialisés`, tokenId: raw });
  } catch (_) {
    return null;
  }
}

async function handleCase7(poolNum = 2, overrideTokenId = null) {
  const VOTER    = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";
  const NFPM_OLD = "0x827922686190790b37229fd06084350E74485b72";
  const NFPM_NEW = "0xe1f8cd9ac4e4a65f54f38a5cdafca44f6dd68b53";
  const FACTORY_NEW = "0xf8f2eb4940cfe7d13603dddd87f123820fc061ef";

  const VOTER_IFACE = new ethers.Interface(["function gauges(address pool) view returns (address)"]);
  const NFPM_IFACE  = new ethers.Interface([
    "function approve(address to, uint256 tokenId)",
    "function setApprovalForAll(address operator, bool approved)",
    "function isApprovedForAll(address owner, address operator) view returns (bool)",
    "function ownerOf(uint256 tokenId) view returns (address)",
    "function balanceOf(address owner) view returns (uint256)",
    "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
    "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  ]);
  const GAUGE_IFACE = new ethers.Interface([
    "function stakedContains(address depositor, uint256 tokenId) view returns (bool)",
    "function deposit(uint256 tokenId)",
    "function deposit(uint256 tokenId, uint256 tokenVeloPair)",
  ]);
  const WETH_ADDR = "0x4200000000000000000000000000000000000006";
  const USDC_ADDR = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

  const privateKey = poolNum === 3 ? process.env.PRIVATE_KEY_3 : process.env.PRIVATE_KEY;
  if (!privateKey)
    return Response.json({ error: `PRIVATE_KEY${poolNum === 3 ? "_3" : ""} manquant` }, { status: 500 });

  // Trouver un RPC fonctionnel (rotation si Alchemy down)
  let provider;
  for (const url of RPC_URLS) {
    try {
      const p = new ethers.JsonRpcProvider(url);
      await p.getBlockNumber();
      provider = p;
      break;
    } catch (_) {}
  }
  if (!provider) return Response.json({ error: "Tous les RPCs sont indisponibles" }, { status: 503 });
  const wallet = new ethers.Wallet(privateKey, provider);

  // Détecter le NFPM selon la factory du pool
  let NFPM = NFPM_OLD;
  try {
    const POOL7 = getPoolAddress(poolNum);
    const factRaw = await provider.call({ to: POOL7, data: "0xc45a0155" });
    const [poolFactory] = ethers.AbiCoder.defaultAbiCoder().decode(["address"], factRaw);
    if (poolFactory.toLowerCase() === FACTORY_NEW) NFPM = NFPM_NEW;
  } catch (_) {}

  // 1. Lire le tokenId — override manuel, sinon DB/Redis, puis scan NFPM wallet
  let tokenId, rawTokenId, dbCandidate;
  if (overrideTokenId) {
    tokenId    = BigInt(overrideTokenId);
    rawTokenId = String(overrideTokenId);
  }
  if (!tokenId) try {
    const state = await getPositionState(poolNum);
    if (state?.token_id) {
      const candidate = BigInt(state.token_id);
      const ownerOk = await provider.call({ to: NFPM, data: NFPM_IFACE.encodeFunctionData("ownerOf", [candidate]) })
        .then(h => { const [o] = NFPM_IFACE.decodeFunctionResult("ownerOf", h); return o.toLowerCase() === wallet.address.toLowerCase(); })
        .catch(() => false);
      if (ownerOk) { tokenId = candidate; rawTokenId = state.token_id; }
      else { dbCandidate = { id: candidate, raw: state.token_id }; } // NFT pas dans le wallet (peut-être déjà staké)
    }
  } catch (_) {}

  // Scan NFPM wallet si pas trouvé via DB
  if (!tokenId) {
    try {
      const countHex = await provider.call({ to: NFPM, data: NFPM_IFACE.encodeFunctionData("balanceOf", [wallet.address]) });
      const [count] = NFPM_IFACE.decodeFunctionResult("balanceOf", countHex);
      for (let i = 0n; i < count; i++) {
        try {
          const [tid] = NFPM_IFACE.decodeFunctionResult("tokenOfOwnerByIndex",
            await provider.call({ to: NFPM, data: NFPM_IFACE.encodeFunctionData("tokenOfOwnerByIndex", [wallet.address, i]) }));
          const pos = NFPM_IFACE.decodeFunctionResult("positions",
            await provider.call({ to: NFPM, data: NFPM_IFACE.encodeFunctionData("positions", [tid]) }));
          if (pos.token0.toLowerCase() === WETH_ADDR.toLowerCase() &&
              pos.token1.toLowerCase() === USDC_ADDR.toLowerCase() &&
              pos.liquidity > 0n) {
            tokenId = tid; rawTokenId = tid.toString(); break;
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  // Fallback DB étendu : chercher le dernier token_id connu toutes actions confondues (CREATE_ERR inclus)
  if (!tokenId && !dbCandidate) {
    try {
      const rows = await sql`
        SELECT token_id FROM lp_events
        WHERE token_id IS NOT NULL AND COALESCE(pool_num, 2) = ${poolNum}
        ORDER BY id DESC LIMIT 1
      `;
      if (rows[0]?.token_id) {
        const candidate = BigInt(rows[0].token_id);
        dbCandidate = { id: candidate, raw: rows[0].token_id };
      }
    } catch (_) {}
  }

  async function waitTx(tx) {
    try {
      const r = await tx.wait();
      if (r?.status === 0) throw new Error("reverted");
      return r;
    } catch (_) {
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const r2 = await provider.getTransactionReceipt(tx.hash).catch(() => null);
        if (r2) {
          if (r2.status === 0) throw new Error(`revert on-chain (${tx.hash})`);
          return r2;
        }
      }
      throw new Error(`timeout tx ${tx.hash}`);
    }
  }

  // 2. Gauge address
  let gaugeAddr;
  try {
    const h = await provider.call({ to: VOTER, data: VOTER_IFACE.encodeFunctionData("gauges", [getPoolAddress(poolNum)]) });
    [gaugeAddr] = VOTER_IFACE.decodeFunctionResult("gauges", h);
    if (!gaugeAddr || gaugeAddr === ethers.ZeroAddress) throw new Error("ZeroAddress");
  } catch (e) {
    return Response.json({ error: `Gauge introuvable : ${e.message}` }, { status: 500 });
  }

  // 2b. Si wallet vide mais DB a un candidat : vérifier gauge puis ownerOf
  if (!tokenId && dbCandidate) {
    // Déjà staké ?
    try {
      const h = await provider.call({ to: gaugeAddr, data: GAUGE_IFACE.encodeFunctionData("stakedContains", [wallet.address, dbCandidate.id]) });
      const [isStaked] = GAUGE_IFACE.decodeFunctionResult("stakedContains", h);
      if (isStaked) {
        await writeErrorState(poolNum, false);
        return Response.json({ ok: true, msg: `NFT #${dbCandidate.raw} déjà staké dans le gauge — état erreur réinitialisé`, tokenId: dbCandidate.raw });
      }
    } catch (_) {}
    // Peut-être dans le wallet mais scan NFPM raté (RPC flaky) — vérifier ownerOf direct
    try {
      const h = await provider.call({ to: NFPM, data: NFPM_IFACE.encodeFunctionData("ownerOf", [dbCandidate.id]) });
      const [owner] = NFPM_IFACE.decodeFunctionResult("ownerOf", h);
      if (owner.toLowerCase() === wallet.address.toLowerCase()) {
        tokenId = dbCandidate.id;
        rawTokenId = dbCandidate.raw;
      }
    } catch (_) {}
    if (!tokenId)
      return await findStakedViaGauge(gaugeAddr, wallet, poolNum) ??
        Response.json({ error: `NFT #${dbCandidate.raw} introuvable (ni dans le wallet ni dans le gauge)` }, { status: 404 });
  }
  if (!tokenId)
    return await findStakedViaGauge(gaugeAddr, wallet, poolNum) ??
      Response.json({ error: "Aucun NFT WETH/USDC trouvé (DB vide + wallet vide)" }, { status: 404 });

  // 3. Déjà staké ?
  try {
    const h = await provider.call({ to: gaugeAddr, data: GAUGE_IFACE.encodeFunctionData("stakedContains", [wallet.address, tokenId]) });
    const [isStaked] = GAUGE_IFACE.decodeFunctionResult("stakedContains", h);
    if (isStaked) {
      await writeErrorState(poolNum, false);
      return Response.json({ ok: true, msg: `NFT #${rawTokenId} déjà staké — état erreur réinitialisé`, tokenId: rawTokenId });
    }
  } catch (_) {}

  // 4. NFT dans le wallet ?
  try {
    const h = await provider.call({ to: NFPM, data: NFPM_IFACE.encodeFunctionData("ownerOf", [tokenId]) });
    const [owner] = NFPM_IFACE.decodeFunctionResult("ownerOf", h);
    if (owner.toLowerCase() !== wallet.address.toLowerCase())
      return Response.json({ error: `NFT #${rawTokenId} appartient à ${owner}, pas au wallet` }, { status: 400 });
  } catch (e) {
    return Response.json({ error: `ownerOf échoué : ${e.message}` }, { status: 500 });
  }

  // 5. Approve tokenId + setApprovalForAll
  try {
    const txApp = await wallet.sendTransaction({ to: NFPM, data: NFPM_IFACE.encodeFunctionData("approve", [gaugeAddr, tokenId]) });
    await waitTx(txApp);
  } catch (e) {
    return Response.json({ error: `approve tokenId échoué : ${e.message}` }, { status: 500 });
  }
  try {
    const needsAll = await provider.call({ to: NFPM, data: NFPM_IFACE.encodeFunctionData("isApprovedForAll", [wallet.address, gaugeAddr]) })
      .then(h => { const [v] = NFPM_IFACE.decodeFunctionResult("isApprovedForAll", h); return !v; })
      .catch(() => true);
    if (needsAll) {
      const txAll = await wallet.sendTransaction({ to: NFPM, data: NFPM_IFACE.encodeFunctionData("setApprovalForAll", [gaugeAddr, true]) });
      await waitTx(txAll).catch(() => {});
    }
  } catch (_) {}

  // 5b. Vérifier la liquidité de la position avant deposit
  let posLiquidity = "?";
  try {
    const posHex = await provider.call({ to: NFPM, data: NFPM_IFACE.encodeFunctionData("positions", [tokenId]) });
    const posData = NFPM_IFACE.decodeFunctionResult("positions", posHex);
    posLiquidity = posData.liquidity.toString();
    if (posData.liquidity === 0n)
      return await findStakedViaGauge(gaugeAddr, wallet, poolNum) ??
        Response.json({ error: `NFT #${rawTokenId} a 0 liquidité — position vide, impossible de staker` }, { status: 400 });
  } catch (_) {}

  // 6. Deposit gauge — essai v2 deposit(tokenId, 0) d'abord, fallback v1 deposit(tokenId)
  let depositHash;
  try {
    // Déterminer la bonne signature via estimateGas (pas de simulation bloquante)
    let depositData = GAUGE_IFACE.encodeFunctionData("deposit(uint256,uint256)", [tokenId, 0n]);
    let gaugeGas = 500000n;
    try {
      const est = await provider.estimateGas({ to: gaugeAddr, from: wallet.address, data: depositData });
      gaugeGas = est * 3n / 2n;
    } catch (_) {
      // v2 échoué → tester v1
      const depositDataV1 = GAUGE_IFACE.encodeFunctionData("deposit(uint256)", [tokenId]);
      try {
        const est2 = await provider.estimateGas({ to: gaugeAddr, from: wallet.address, data: depositDataV1 });
        depositData = depositDataV1;
        gaugeGas = est2 * 3n / 2n;
      } catch (_2) {}
    }
    const txDeposit = await wallet.sendTransaction({ to: gaugeAddr, data: depositData, gasLimit: gaugeGas });
    depositHash = txDeposit.hash;
    await waitTx(txDeposit);
  } catch (e) {
    return Response.json({ error: `deposit gauge échoué : ${e.message}` }, { status: 500 });
  }

  // 7. Effacer l'état d'erreur + mettre à jour DB pour que collectFees utilise le bon tokenId
  await writeErrorState(poolNum, false);
  try {
    await sql`
      INSERT INTO lp_events (action1, action2, token_id, pool_num, created_at)
      VALUES ('CREATE_OK', NULL, ${rawTokenId}, ${poolNum}, NOW())
    `;
    await writeLpState(poolNum, { action1: "CREATE_OK", action2: null, token_id: rawTokenId, created_at: new Date().toISOString() });
  } catch (_) {}
  return Response.json({ ok: true, msg: `NFT #${rawTokenId} restaké avec succès`, txDeposit: depositHash, tokenId: rawTokenId });
}

async function handleCase4(poolNum = 2) {
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  if (!base) return Response.json({ error: "APP_URL non configuré" }, { status: 500 });

  // Helper timeout Redis — si Upstash pend, on continue avec la valeur par défaut
  const withTimeout = (p, ms, def) => Promise.race([p.catch(() => def), new Promise(r => setTimeout(() => r(def), ms))]);

  // 1. Vérifier que la dernière position est fermée (Redis → DB, timeout 5s)
  try {
    const state = await withTimeout(getPositionState(poolNum), 5000, null);
    if (state && state.action2 !== "CLOSE_OK")
      return Response.json({ skipped: true, reason: "Dernière position non fermée ou inexistante" });
  } catch (e) {
    return Response.json({ error: `DB check failed: ${e.message}` }, { status: 500 });
  }

  // 2. Range via percentiles 24h, minimum 2%
  let newRangePct = 2;
  try {
    const pct = await getPercentileRange();
    if (pct && pct.cnt >= 10 && pct.p05 > 0)
      newRangePct = Math.max(2, ((pct.p95 - pct.p05) / pct.p05) * 100);
  } catch (_) {}
  newRangePct = parseFloat((newRangePct * (poolNum === 3 ? RANGE_COEFF_3 : RANGE_COEFF_2)).toFixed(2));

  // Vérifier le solde USDC du wallet (min 50$) — skippe par défaut si lecture impossible
  {
    const privateKey = poolNum === 3 ? process.env.PRIVATE_KEY_3 : process.env.PRIVATE_KEY;
    const USDC_ADDR  = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    let usdcBal      = 0;
    let balRead      = false;
    try {
      const walletAddr = privateKey ? new ethers.Wallet(privateKey).address : null;
      if (walletAddr) {
        const walletPad = walletAddr.slice(2).toLowerCase().padStart(64, "0");
        for (const url of RPC_URLS) {
          try {
            const res  = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC_ADDR, data: "0x70a08231" + walletPad }, "latest"] }),
              signal: AbortSignal.timeout(6000),
            });
            const json = await res.json();
            if (json.result && json.result !== "0x") {
              usdcBal  = Number(ethers.toBigInt(json.result)) / 1e6;
              balRead  = true;
              break;
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
    if (!balRead || usdcBal < 50)
      return Response.json({ skipped: true, reason: `Solde USDC insuffisant : $${usdcBal.toFixed(2)} (min $50)${!balRead ? " — lecture RPC échouée" : ""}` });
  }

  // 2b. Vérifier limite 4 rebalances en 24h (même garde que cas 1/2/3)
  try {
    const cnt = await sql`
      SELECT COUNT(*)::int AS n FROM lp_events
      WHERE action1 = 'CREATE_OK' AND COALESCE(pool_num, 2) = ${poolNum}
        AND created_at > NOW() - INTERVAL '24 hours'
    `;
    if (cnt[0].n >= 4)
      return Response.json({ skipped: true, reason: `4 rebalances déjà effectués dans les 24h (pool ${poolNum})` });
  } catch (e) {
    return Response.json({ error: `DB check failed: ${e.message}` }, { status: 500 });
  }

  const livePrice4 = await getPoolWethPrice(0);
  if (!livePrice4 || livePrice4 < 100 || livePrice4 > 100000)
    return Response.json({ skipped: true, reason: `Prix WETH on-chain invalide : ${livePrice4}` });

  const sqrtRatio = Math.sqrt(1 + newRangePct / 100);
  const minPrice  = livePrice4 / sqrtRatio;
  const maxPrice  = livePrice4 * sqrtRatio;

  // 3. Toutes les conditions sont remplies → acquérir le lock (timeout 5s si Redis pend)
  let release;
  try {
    const r = await withTimeout(acquireRedisLock(), 5000, null);
    if (!r) return Response.json({ error: `Exécution déjà en cours ou Redis indisponible — réessayer dans 1 min` }, { status: 409 });
    release = r;
  } catch (e) {
    return Response.json({ error: `Lock Redis échoué : ${e.message}` }, { status: 500 });
  }

  try {
    // 4. Fermer toutes les positions Hyperliquid résiduelles (pool 2 uniquement)
    if (poolNum === 2) {
      try {
        const hlRes  = await fetch(`${base}/api/hyperliquid-cancel-all`, {
          method: "POST",
          signal: AbortSignal.timeout(30000),
        });
        const hlData = await hlRes.json();
        if (!hlRes.ok) throw new Error(typeof hlData?.error === "string" ? hlData.error : JSON.stringify(hlData));
      } catch (e) { throw new Error(`hyperliquid-cancel-all failed: ${e?.message ?? String(e)}`); }
    }

    // 5. Créer nouvelle position 50/50
    const res = await fetch(`${base}/api/createPosition`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountUSDC: 999999, minPrice, maxPrice, currentPrice: livePrice4, targetRatio: 0.5, poolNum, caseNum: 4 }),
      signal: AbortSignal.timeout(90000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : JSON.stringify(data?.error ?? "createPosition failed"));

    await release();
    return Response.json({ ok: true, case: 4, newRangePct, livePrice: livePrice4, minPrice: minPrice.toFixed(0), maxPrice: maxPrice.toFixed(0), createResult: data });
  } catch (e) {
    await release();
    const msg = e?.message ?? String(e);
    await sendErrorEmail(
      "[CryptoYieldTracker] Erreur — Cas 4 création position",
      `Prix ETH : $${livePrice4}\nRange    : ${newRangePct}%\nMin      : $${minPrice.toFixed(0)}\nMax      : $${maxPrice.toFixed(0)}\n\nErreur : ${msg}`
    );
    return Response.json({ error: msg }, { status: 500 });
  }
}

// Case 9 — fermeture strategy start pool 2 (hors range ou TP/SL HL exécuté), sans réouverture
async function handleCase9(poolNum = 2, noTransfer = false) {
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  if (!base) return Response.json({ error: "APP_URL non configuré" }, { status: 500 });

  const release = await acquireRedisLock();
  if (!release) return Response.json({ error: "Exécution déjà en cours — réessayer dans 5 min" }, { status: 409 });

  try {
    // 1. Fermer la position LP
    const closeRes  = await fetch(`${base}/api/closePositions`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ keepWeth: false, poolNum, caseNum: 9, noTransfer }),
      signal:  AbortSignal.timeout(200000),
    });
    const closeData = await closeRes.json();
    if (!closeRes.ok) throw new Error(closeData?.error ?? "closePositions failed");

    // 2. Annuler ordres + fermer position HL (pool 2 uniquement)
    let hlCloseData = null;
    if (poolNum !== 3) {
      try {
        const hlRes = await fetch(`${base}/api/hyperliquid-cancel-all`, {
          method: "POST",
          signal: AbortSignal.timeout(30000),
        });
        hlCloseData = await hlRes.json();
      } catch (_) {}
    }

    await release();
    return Response.json({ ok: true, case: 9, closeData, hlCloseData });
  } catch (e) {
    await release();
    const msg = e?.message ?? String(e);
    await sendErrorEmail("[CryptoYieldTracker] Erreur — Cas 9 (close start pool2)", `Erreur : ${msg}`);
    await writeErrorState(poolNum, true, msg);
    return Response.json({ case: 9, error: msg }, { status: 500 });
  }
}

// Case 10 — rebalance manuel pool 2 : close LP (keepWeth) + close HL + create + HL short delta-neutre
async function handleCase10(poolNum = 2) {
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  if (!base) return Response.json({ error: "APP_URL non configuré" }, { status: 500 });

  // 1. Prix live
  const livePrice = await getPoolWethPrice(0);
  if (!livePrice || livePrice < 100 || livePrice > 100000)
    return Response.json({ skipped: true, reason: `Prix WETH invalide : ${livePrice}` });

  // 2. Levier HL actuel (lu avant fermeture)
  let hlLeverage = 4;
  try {
    const hlRes  = await fetch(`${base}/api/hyperliquid-status`, { signal: AbortSignal.timeout(10000) });
    const hlData = await hlRes.json();
    const ethShort = (hlData.positions ?? []).find(p => p.coin === "ETH" && p.side === "short");
    if (ethShort?.leverage) hlLeverage = ethShort.leverage;
  } catch (_) {}

  // 3. Range : 10% fixe pour pool 2, percentile 24h × 4 pour pool 3
  let rangePct;
  if (poolNum === 2) {
    rangePct = 10;
  } else {
    rangePct = 2;
    try {
      const pct = await getPercentileRange();
      if (pct && pct.cnt >= 10 && pct.p05 > 0)
        rangePct = Math.max(2, ((pct.p95 - pct.p05) / pct.p05) * 100 * 4);
    } catch (_) {}
  }

  // 4. Lock
  const release = await acquireRedisLock();
  if (!release) return Response.json({ error: "Exécution déjà en cours" }, { status: 409 });

  try {
    // 5. Fermer LP — garder WETH, vendre fees WETH, pas de transfert destination
    const closeRes  = await fetch(`${base}/api/closePositions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keepWeth: true, sellWethFees: true, noTransfer: true, poolNum, caseNum: 10 }),
      signal: AbortSignal.timeout(200000),
    });
    const closeData = await closeRes.json();
    if (!closeRes.ok) throw new Error(closeData?.error ?? "closePositions failed");

    // 6. Fermer position Hyperliquid
    let hlCloseData = null;
    try {
      const hlCloseRes = await fetch(`${base}/api/hyperliquid-cancel-all`, { method: "POST", signal: AbortSignal.timeout(30000) });
      hlCloseData = await hlCloseRes.json();
    } catch (_) {}

    // 7. Bornes : exactBounds centré sur livePrice, range = percentile × 2
    const halfFrac = rangePct / 200;
    const minPrice = livePrice / (1 + halfFrac);
    const maxPrice = livePrice * (1 + halfFrac);

    // 8. Créer nouvelle position
    const createRes  = await fetch(`${base}/api/createPosition`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amountUSDC: 999999, minPrice, maxPrice, currentPrice: livePrice,
        targetRatio: 0.5, poolNum, exactBounds: true, caseNum: 10,
      }),
      signal: AbortSignal.timeout(120000),
    });
    const createData = await createRes.json();
    if (!createRes.ok) throw new Error(createData?.error ?? "createPosition failed");

    // 9. Short HL delta-neutre
    const Pa  = createData.tickLowerPrice;
    const Pb  = createData.tickUpperPrice;
    const P0  = livePrice;
    const poolAmount = createData.totalBudgetUSD ?? 0;
    let hlShortData = null;
    if (poolAmount > 10 && Pa > 0 && Pb > 0) {
      try {
        const sqrtP0 = Math.sqrt(P0);
        const sqrtPa = Math.sqrt(Pa);
        const sqrtPb = Math.sqrt(Pb);
        const L         = poolAmount / (2 * sqrtP0 - P0 / sqrtPb - sqrtPa);
        const ethAtOpen = Math.max(0, L * (1 / sqrtP0 - 1 / sqrtPb));
        if (ethAtOpen > 0.001) {
          const shortRes = await fetch(`${base}/api/hyperliquid-short`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sizeEth: parseFloat(ethAtOpen.toFixed(4)), leverage: hlLeverage, slPriceTrigger: Pb }),
            signal: AbortSignal.timeout(30000),
          });
          hlShortData = await shortRes.json();
        }
      } catch (e) {
        hlShortData = { error: e?.message ?? String(e) };
      }
    }

    await release();
    return Response.json({
      ok: true, case: 10, rangePct: parseFloat(rangePct.toFixed(2)), livePrice,
      minPrice: minPrice.toFixed(0), maxPrice: maxPrice.toFixed(0),
      closeData, hlCloseData, createResult: createData, hlShort: hlShortData,
    });
  } catch (e) {
    await release();
    const msg = e?.message ?? String(e);
    await sendErrorEmail("[CryptoYieldTracker] Erreur — Cas 10 (rebalance manuel pool2)", `Prix ETH : $${livePrice}\n\nErreur : ${msg}`);
    await writeErrorState(poolNum, true, msg);
    return Response.json({ case: 10, error: msg }, { status: 500 });
  }
}
