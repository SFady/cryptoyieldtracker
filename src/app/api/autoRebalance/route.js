import { ethers } from "ethers";
import { neon } from "@neondatabase/serverless";
import { getLastTwoPrices, getPercentileRange, readLpState, writeLpState, wasCollectedToday, readErrorState, writeErrorState, readCollectErr, writeCollectErr, checkRedisLock, acquireRedisLock } from "../../lib/cronKv";
import { POOL_ADDRESS } from "../../lib/config";

export const runtime     = "nodejs";
export const maxDuration = 300;

const RANGE_COEFF_2 = 1;   // multiplicateur range pool 2
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

async function handleRequest(forceCase, poolNum = 2) {
  if (![1, 2, 3, 4, 5, 6, 7, 8].includes(forceCase))
    return Response.json({ skipped: true, reason: `Cas ${forceCase} non implémenté` });

  // Cases de recovery — bypass des checks lock/erreur
  if (forceCase === 7) return handleCase7(poolNum);
  if (forceCase === 8) return handleCase8(poolNum);

  // 1. Vérifier si une exécution est déjà active (lock Redis — TTL 5 min automatique)
  if (await checkRedisLock())
    return Response.json({ error: `Exécution déjà en cours — réessayer dans 5 min` }, { status: 409 });

  // 2. Vérifier l'absence d'erreur (Redis → DB)
  try {
    const cached = await readErrorState(poolNum);
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
        await writeErrorState(poolNum, hasError, error_msg ?? null);
        if (hasError)
          return Response.json({ error: `Bloqué — erreur détectée en base : ${error_msg ?? action1}` }, { status: 409 });
      } else {
        await writeErrorState(poolNum, false);
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
  const forceCase = parseInt(p.get("case")    ?? "0");
  const poolNum   = parseInt(p.get("poolNum") ?? "2");
  return handleRequest(forceCase, poolNum);
}

export async function POST(req) {
  const { forceCase, poolNum } = await req.json().catch(() => ({}));
  return handleRequest(forceCase, poolNum ?? 2);
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

    // 5. Créer nouvelle position 50% WETH / 50% USDC
    const res = await fetch(`${base}/api/createPosition`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountUSDC: 999999, minPrice: liveMinPrice, maxPrice: liveMaxPrice, currentPrice: livePrice, targetRatio: 0.7, poolNum, caseNum: 1 }),
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
        body: JSON.stringify({ keepWeth: true, threeQuarterFees: true, poolNum, caseNum: 2 }),
        signal: AbortSignal.timeout(200000),
      });
      closeData = await res.json();
      if (!res.ok) throw new Error(typeof closeData?.error === "string" ? closeData.error : JSON.stringify(closeData?.error ?? "close failed"));
      if (!closeData.collected?.length) throw new Error(`closePositions n'a rien collecté — position introuvable dans le gauge (tokenId=${lastPos.token_id})`);
    } catch (e) { throw new Error(`closePositions failed: ${e?.message ?? String(e)}`); }

    // 5. Créer nouvelle position 50/50
    const res = await fetch(`${base}/api/createPosition`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountUSDC: 999999, minPrice: liveMinPrice, maxPrice: liveMaxPrice, currentPrice: livePrice, targetRatio: 0.3, poolNum, caseNum: 2 }),
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
      body: JSON.stringify({ poolNum, caseNum: 6 }),
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
  await writeCollectErr(poolNum, false);
  return Response.json({ ok: true, msg: `Erreur COLLECT_ERR réinitialisée pour pool ${poolNum}` });
}

async function handleCase7(poolNum = 2) {
  const VOTER = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";
  const NFPM  = "0x827922686190790b37229fd06084350E74485b72";

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
  ]);
  const WETH_ADDR = "0x4200000000000000000000000000000000000006";
  const USDC_ADDR = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

  const privateKey = poolNum === 3 ? process.env.PRIVATE_KEY_3 : process.env.PRIVATE_KEY;
  if (!privateKey)
    return Response.json({ error: `PRIVATE_KEY${poolNum === 3 ? "_3" : ""} manquant` }, { status: 500 });

  const provider = new ethers.JsonRpcProvider(RPC_URLS[0]);
  const wallet   = new ethers.Wallet(privateKey, provider);

  // 1. Lire le tokenId — DB/Redis d'abord, puis scan NFPM wallet si invalide/brûlé
  let tokenId, rawTokenId, dbCandidate;
  try {
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
    const h = await provider.call({ to: VOTER, data: VOTER_IFACE.encodeFunctionData("gauges", [POOL_ADDRESS]) });
    [gaugeAddr] = VOTER_IFACE.decodeFunctionResult("gauges", h);
    if (!gaugeAddr || gaugeAddr === ethers.ZeroAddress) throw new Error("ZeroAddress");
  } catch (e) {
    return Response.json({ error: `Gauge introuvable : ${e.message}` }, { status: 500 });
  }

  // 2b. Si wallet vide mais DB a un candidat, vérifier si déjà staké dans le gauge
  if (!tokenId && dbCandidate) {
    try {
      const h = await provider.call({ to: gaugeAddr, data: GAUGE_IFACE.encodeFunctionData("stakedContains", [wallet.address, dbCandidate.id]) });
      const [isStaked] = GAUGE_IFACE.decodeFunctionResult("stakedContains", h);
      if (isStaked) {
        await writeErrorState(poolNum, false);
        return Response.json({ ok: true, msg: `NFT #${dbCandidate.raw} déjà staké dans le gauge — état erreur réinitialisé`, tokenId: dbCandidate.raw });
      }
    } catch (_) {}
    return Response.json({ error: `NFT #${dbCandidate.raw} introuvable (ni dans le wallet ni dans le gauge)` }, { status: 404 });
  }
  if (!tokenId)
    return Response.json({ error: "Aucun NFT WETH/USDC trouvé (DB vide + wallet vide)" }, { status: 404 });

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

  // 6. Deposit dans le gauge
  let depositHash;
  try {
    let gaugeGas = 300000n;
    try { const est = await provider.estimateGas({ to: gaugeAddr, from: wallet.address, data: GAUGE_IFACE.encodeFunctionData("deposit", [tokenId]) }); gaugeGas = est * 3n / 2n; } catch (_) {}
    const txDeposit = await wallet.sendTransaction({ to: gaugeAddr, data: GAUGE_IFACE.encodeFunctionData("deposit", [tokenId]), gasLimit: gaugeGas });
    depositHash = txDeposit.hash;
    await waitTx(txDeposit);
  } catch (e) {
    return Response.json({ error: `deposit gauge échoué : ${e.message}` }, { status: 500 });
  }

  // 7. Effacer l'état d'erreur
  await writeErrorState(poolNum, false);
  return Response.json({ ok: true, msg: `NFT #${rawTokenId} restaké avec succès`, txDeposit: depositHash, tokenId: rawTokenId });
}

async function handleCase4(poolNum = 2) {
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  if (!base) return Response.json({ error: "APP_URL non configuré" }, { status: 500 });

  // 1. Vérifier que la dernière position est fermée (Redis → DB)
  try {
    const state = await getPositionState(poolNum);
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

  const livePrice4 = await getPoolWethPrice(0);
  if (!livePrice4 || livePrice4 < 100 || livePrice4 > 100000)
    return Response.json({ skipped: true, reason: `Prix WETH on-chain invalide : ${livePrice4}` });

  const sqrtRatio = Math.sqrt(1 + newRangePct / 100);
  const minPrice  = livePrice4 / sqrtRatio;
  const maxPrice  = livePrice4 * sqrtRatio;

  // 3. Toutes les conditions sont remplies → acquérir le lock
  let release;
  release = await acquireRedisLock();
  if (!release) return Response.json({ error: `Exécution déjà en cours — réessayer dans 5 min` }, { status: 409 });

  try {
    // 4. Créer nouvelle position 50/50
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
