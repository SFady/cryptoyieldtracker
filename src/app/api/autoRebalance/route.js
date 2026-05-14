import { neon } from "@neondatabase/serverless";

export const runtime     = "nodejs";
export const maxDuration = 300;

const sql = neon(process.env.DATABASE_URL);

const POOL_ADDRESS = "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";
const RPC_URLS = [
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
];

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

async function handleRequest(forceCase) {
  if (![1, 2, 3, 4].includes(forceCase))
    return Response.json({ skipped: true, reason: `Cas ${forceCase} non implémenté` });

  // 1. Expirer les locks bloqués depuis > 5 min, puis vérifier si une exécution est déjà active
  try {
    await sql`
      UPDATE lp_events
      SET action2 = 'TIMEOUT', error_msg = 'Timeout automatique 5 min'
      WHERE action1 = 'RUNNING' AND action2 IS NULL
        AND created_at < NOW() - INTERVAL '5 minutes'
    `;
    const active = await sql`
      SELECT token_id FROM lp_events
      WHERE action1 = 'RUNNING' AND action2 IS NULL
      LIMIT 1
    `;
    if (active.length > 0)
      return Response.json({ error: `Exécution déjà en cours — réessayer dans 5 min` }, { status: 409 });
  } catch (e) {
    return Response.json({ error: `Lock check échoué : ${e.message}` }, { status: 500 });
  }

  // 2. Vérifier l'absence d'erreur en base (même garde que le frontend)
  try {
    const errRows = await sql`
      SELECT action1, action2, error_msg FROM lp_events
      WHERE action1 != 'RUNNING'
      ORDER BY id DESC LIMIT 1
    `;
    if (errRows.length > 0) {
      const { action1, action2, error_msg } = errRows[0];
      if ((action1 && action1.includes("ERR")) || (action2 && action2.includes("ERR")))
        return Response.json({
          error: `Bloqué — erreur détectée en base : ${error_msg ?? action1}`,
        }, { status: 409 });
    }
  } catch (e) {
    return Response.json({ error: `Error check échoué : ${e.message}` }, { status: 500 });
  }

  // 3. Acquérir le verrou
  const lockId = `LOCK_${Date.now()}`;
  try {
    await sql`INSERT INTO lp_events (action1, token_id) VALUES ('RUNNING', ${lockId})`;
  } catch (e) {
    return Response.json({ error: `Lock insert échoué : ${e.message}` }, { status: 500 });
  }

  // 4. Exécuter le cas et retirer le verrou (skip ou erreur explicite → DELETE, timeout Vercel → reste en base)
  const releaseLock = async () => {
    try { await sql`DELETE FROM lp_events WHERE action1 = 'RUNNING' AND token_id = ${lockId}`; } catch (_) {}
  };

  try {
    let result;
    if (forceCase === 1) result = await handleCase1();
    else if (forceCase === 2) result = await handleCase2();
    else if (forceCase === 3) result = await handleCase3();
    else if (forceCase === 4) result = await handleCase4();
    else result = Response.json({ skipped: true, reason: `Cas ${forceCase} non implémenté` });

    await releaseLock();
    return result;
  } catch (e) {
    await releaseLock();
    return Response.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

export async function GET(req) {
  const forceCase = parseInt(new URL(req.url).searchParams.get("case") ?? "0");
  return handleRequest(forceCase);
}

export async function POST(req) {
  const { forceCase } = await req.json().catch(() => ({}));
  return handleRequest(forceCase);
}

async function handleCase1() {
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  if (!base) return Response.json({ error: "APP_URL non configuré" }, { status: 500 });

  // 1. Prix WETH on-chain
  const livePrice = await getPoolWethPrice(0);
  if (!livePrice || livePrice < 100 || livePrice > 100000)
    return Response.json({ skipped: true, reason: `Prix WETH on-chain invalide : ${livePrice}` });

  // 2. Vérifier position ouverte en DB
  let lastPos;
  try {
    const rows = await sql`
      SELECT usdc_placed, range_pct, range_min, action2, usdc_remaining FROM lp_events
      WHERE action1 = 'CREATE_OK'
      ORDER BY id DESC LIMIT 1
    `;
    if (rows.length === 0 || rows[0].action2 !== null)
      return Response.json({ skipped: true, reason: "Aucune position ouverte en DB" });
    lastPos = rows[0];
  } catch (e) {
    return Response.json({ error: `DB check failed: ${e.message}` }, { status: 500 });
  }

  const usdcPlaced    = parseFloat(lastPos.usdc_placed);
  const rangePct      = parseFloat(lastPos.range_pct);
  const rangeMin      = parseFloat(lastPos.range_min);
  const usdcRemaining = parseFloat(lastPos.usdc_remaining) || 0;
  if (!usdcPlaced || isNaN(usdcPlaced) || !rangePct || isNaN(rangePct))
    return Response.json({ skipped: true, reason: "Données position invalides en DB" });

  if (!isNaN(rangeMin) && livePrice >= rangeMin)
    return Response.json({ skipped: true, reason: `Prix WETH $${livePrice.toFixed(2)} >= borne basse $${rangeMin} — pas hors range bas` });

  const newRangePct = Math.max(2, rangePct * 1.5);
  const sqrtRatio   = Math.sqrt(1 + newRangePct / 100);

  // 3. Fermer la position actuelle
  let closeData;
  try {
    const res = await fetch(`${base}/api/closePositions`, {
      method: "POST",
      signal: AbortSignal.timeout(240000),
    });
    closeData = await res.json();
    if (!res.ok) {
      const errMsg = typeof closeData?.error === "string" ? closeData.error : (closeData?.error ? JSON.stringify(closeData.error) : "close failed");
      throw new Error(errMsg);
    }
  } catch (e) {
    const msg = e?.message ?? e?.shortMessage ?? String(e);
    return Response.json({ error: `closePositions failed: ${msg}` }, { status: 500 });
  }

  const liveMinPrice = livePrice / sqrtRatio;
  const liveMaxPrice = livePrice * sqrtRatio;
  const amountUSDC1  = (parseFloat(closeData?.principalUsdc) || usdcPlaced) + usdcRemaining;

  // 4. Créer nouvelle position 80% WETH / 20% USDC
  try {
    const res = await fetch(`${base}/api/createPosition`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        amountUSDC:  amountUSDC1,
        minPrice:    liveMinPrice,
        maxPrice:    liveMaxPrice,
        currentPrice: livePrice,
        targetRatio: 0.70,
        poolNum:     2,
        caseNum:     1,
      }),
      signal: AbortSignal.timeout(240000),
    });
    const data = await res.json();
    if (!res.ok) {
      const errMsg = typeof data?.error === "string" ? data.error : (data?.error ? JSON.stringify(data.error) : "createPosition failed");
      throw new Error(errMsg);
    }
    return Response.json({
      ok:           true,
      case:         1,
      newRangePct,
      livePrice,
      minPrice:     liveMinPrice.toFixed(0),
      maxPrice:     liveMaxPrice.toFixed(0),
      amountUSDC:   amountUSDC1,
      closeResult:  closeData,
      createResult: data,
    });
  } catch (e) {
    const msg = e?.message ?? e?.shortMessage ?? String(e);
    return Response.json({ case: 1, closeResult: closeData, error: `createPosition failed: ${msg}` }, { status: 500 });
  }
}

async function handleCase2() {
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  if (!base) return Response.json({ error: "APP_URL non configuré" }, { status: 500 });

  // 1. Prix WETH on-chain
  const livePrice = await getPoolWethPrice(0);
  if (!livePrice || livePrice < 100 || livePrice > 100000)
    return Response.json({ skipped: true, reason: `Prix WETH on-chain invalide : ${livePrice}` });

  // 2. Vérifier position ouverte en DB
  let lastPos;
  try {
    const rows = await sql`
      SELECT usdc_placed, range_pct, range_max, action2, usdc_remaining FROM lp_events
      WHERE action1 = 'CREATE_OK'
      ORDER BY id DESC LIMIT 1
    `;
    if (rows.length === 0 || rows[0].action2 !== null)
      return Response.json({ skipped: true, reason: "Aucune position ouverte en DB" });
    lastPos = rows[0];
  } catch (e) {
    return Response.json({ error: `DB check failed: ${e.message}` }, { status: 500 });
  }

  const usdcPlaced    = parseFloat(lastPos.usdc_placed);
  const rangePct      = parseFloat(lastPos.range_pct);
  const rangeMax      = parseFloat(lastPos.range_max);
  const usdcRemaining = parseFloat(lastPos.usdc_remaining) || 0;
  if (!usdcPlaced || isNaN(usdcPlaced) || !rangePct || isNaN(rangePct))
    return Response.json({ skipped: true, reason: "Données position invalides en DB" });

  if (!isNaN(rangeMax) && livePrice <= rangeMax)
    return Response.json({ skipped: true, reason: `Prix WETH $${livePrice.toFixed(2)} <= borne haute $${rangeMax} — pas hors range haut` });

  const newRangePct = Math.max(2, rangePct * 1.5);
  const sqrtRatio   = Math.sqrt(1 + newRangePct / 100);

  // 3. Fermer la position actuelle
  let closeData;
  try {
    const res = await fetch(`${base}/api/closePositions`, {
      method: "POST",
      signal: AbortSignal.timeout(240000),
    });
    closeData = await res.json();
    if (!res.ok) {
      const errMsg = typeof closeData?.error === "string" ? closeData.error : (closeData?.error ? JSON.stringify(closeData.error) : "close failed");
      throw new Error(errMsg);
    }
  } catch (e) {
    const msg = e?.message ?? e?.shortMessage ?? String(e);
    return Response.json({ error: `closePositions failed: ${msg}` }, { status: 500 });
  }

  const liveMinPrice = livePrice / sqrtRatio;
  const liveMaxPrice = livePrice * sqrtRatio;
  const amountUSDC2  = (parseFloat(closeData?.principalUsdc) || usdcPlaced) + usdcRemaining;

  // 4. Créer nouvelle position 20% WETH / 80% USDC
  try {
    const res = await fetch(`${base}/api/createPosition`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        amountUSDC:  amountUSDC2,
        minPrice:     liveMinPrice,
        maxPrice:     liveMaxPrice,
        currentPrice: livePrice,
        targetRatio:  0.30,
        poolNum:      2,
        caseNum:      2,
      }),
      signal: AbortSignal.timeout(240000),
    });
    const data = await res.json();
    if (!res.ok) {
      const errMsg = typeof data?.error === "string" ? data.error : (data?.error ? JSON.stringify(data.error) : "createPosition failed");
      throw new Error(errMsg);
    }
    return Response.json({
      ok:           true,
      case:         2,
      newRangePct,
      livePrice,
      minPrice:     liveMinPrice.toFixed(0),
      maxPrice:     liveMaxPrice.toFixed(0),
      amountUSDC:   amountUSDC2,
      closeResult:  closeData,
      createResult: data,
    });
  } catch (e) {
    const msg = e?.message ?? e?.shortMessage ?? String(e);
    return Response.json({ case: 2, closeResult: closeData, error: `createPosition failed: ${msg}` }, { status: 500 });
  }
}

async function handleCase3() {
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  if (!base) return Response.json({ error: "APP_URL non configuré" }, { status: 500 });

  // 1. Prix WETH on-chain
  const livePrice = await getPoolWethPrice(0);
  if (!livePrice || livePrice < 100 || livePrice > 100000)
    return Response.json({ skipped: true, reason: `Prix WETH on-chain invalide : ${livePrice}` });

  // 2. Vérifier position ouverte en DB
  let lastPos;
  try {
    const rows = await sql`
      SELECT usdc_placed, range_pct, range_min, range_max, action2, created_at, usdc_remaining FROM lp_events
      WHERE action1 = 'CREATE_OK'
      ORDER BY id DESC LIMIT 1
    `;
    if (rows.length === 0 || rows[0].action2 !== null)
      return Response.json({ skipped: true, reason: "Aucune position ouverte en DB" });
    lastPos = rows[0];
  } catch (e) {
    return Response.json({ error: `DB check failed: ${e.message}` }, { status: 500 });
  }

  const usdcPlaced    = parseFloat(lastPos.usdc_placed);
  const rangePct      = parseFloat(lastPos.range_pct);
  const rangeMin      = parseFloat(lastPos.range_min);
  const rangeMax      = parseFloat(lastPos.range_max);
  const usdcRemaining = parseFloat(lastPos.usdc_remaining) || 0;
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

  // 5. Calculer le range via percentiles 24h (même logique que cas 4)
  let newRangePct = 2;
  try {
    const rows = await sql`
      SELECT
        PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY weth) AS p05,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY weth) AS p95,
        COUNT(*)::int AS cnt
      FROM cron_runs
      WHERE weth IS NOT NULL
        AND ran_at > NOW() - INTERVAL '24 hours'
    `;
    const { p05, p95, cnt } = rows[0];
    if (cnt >= 10 && p05 > 0)
      newRangePct = Math.max(2, ((p95 - p05) / p05) * 100);
  } catch (_) {}
  newRangePct = parseFloat(newRangePct.toFixed(2));

  const sqrtRatio    = Math.sqrt(1 + newRangePct / 100);
  const liveMinPrice = livePrice / sqrtRatio;
  const liveMaxPrice = livePrice * sqrtRatio;

  // 6. Fermer la position actuelle
  let closeData;
  try {
    const res = await fetch(`${base}/api/closePositions`, {
      method: "POST",
      signal: AbortSignal.timeout(240000),
    });
    closeData = await res.json();
    if (!res.ok) {
      const errMsg = typeof closeData?.error === "string" ? closeData.error : (closeData?.error ? JSON.stringify(closeData.error) : "close failed");
      throw new Error(errMsg);
    }
  } catch (e) {
    const msg = e?.message ?? e?.shortMessage ?? String(e);
    return Response.json({ error: `closePositions failed: ${msg}` }, { status: 500 });
  }

  // 7. Créer nouvelle position 50/50 avec le range calculé
  const amountUSDC3 = (parseFloat(closeData?.principalUsdc) || usdcPlaced) + usdcRemaining;
  try {
    const res = await fetch(`${base}/api/createPosition`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        amountUSDC:  amountUSDC3,
        minPrice:     liveMinPrice,
        maxPrice:     liveMaxPrice,
        currentPrice: livePrice,
        targetRatio:  0.5,
        poolNum:      2,
        caseNum:      3,
      }),
      signal: AbortSignal.timeout(240000),
    });
    const data = await res.json();
    if (!res.ok) {
      const errMsg = typeof data?.error === "string" ? data.error : (data?.error ? JSON.stringify(data.error) : "createPosition failed");
      throw new Error(errMsg);
    }
    return Response.json({
      ok:           true,
      case:         3,
      ageHours:     ageHours.toFixed(1),
      newRangePct,
      livePrice,
      minPrice:     liveMinPrice.toFixed(0),
      maxPrice:     liveMaxPrice.toFixed(0),
      amountUSDC:   amountUSDC3,
      closeResult:  closeData,
      createResult: data,
    });
  } catch (e) {
    const msg = e?.message ?? e?.shortMessage ?? String(e);
    return Response.json({ case: 3, closeResult: closeData, error: `createPosition failed: ${msg}` }, { status: 500 });
  }
}

async function handleCase4() {
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  if (!base) return Response.json({ error: "APP_URL non configuré" }, { status: 500 });

  // 1. Vérifier que la dernière ligne CREATE_OK est fermée (action2 = 'CLOSE_OK')
  try {
    const rows = await sql`
      SELECT action2 FROM lp_events
      WHERE action1 != 'RUNNING'
      ORDER BY id DESC LIMIT 1
    `;
    if (rows.length === 0 || rows[0].action2 !== "CLOSE_OK")
      return Response.json({ skipped: true, reason: "Dernière position non fermée ou inexistante" });
  } catch (e) {
    return Response.json({ error: `DB check failed: ${e.message}` }, { status: 500 });
  }

  // 2. Range via percentiles 24h (cron_runs), minimum 2%
  let newRangePct = 2;
  try {
    const rows = await sql`
      SELECT
        PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY weth) AS p05,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY weth) AS p95,
        COUNT(*)::int AS cnt
      FROM cron_runs
      WHERE weth IS NOT NULL
        AND ran_at > NOW() - INTERVAL '24 hours'
    `;
    const { p05, p95, cnt } = rows[0];
    if (cnt >= 10 && p05 > 0)
      newRangePct = Math.max(2, ((p95 - p05) / p05) * 100);
  } catch (_) {}
  newRangePct = parseFloat(newRangePct.toFixed(2));

  const livePrice4 = await getPoolWethPrice(0);
  const sqrtRatio  = Math.sqrt(1 + newRangePct / 100);
  const minPrice   = livePrice4 / sqrtRatio;
  const maxPrice   = livePrice4 * sqrtRatio;

  // 3. Créer nouvelle position 50/50 — 100 USDC
  try {
    const res = await fetch(`${base}/api/createPosition`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        amountUSDC:   999999,
        minPrice,
        maxPrice,
        currentPrice: livePrice4,
        targetRatio:  0.5,
        poolNum:      2,
        caseNum:      4,
      }),
      signal: AbortSignal.timeout(240000),
    });
    const data = await res.json();
    if (!res.ok) {
      const errMsg = typeof data?.error === "string" ? data.error : (data?.error ? JSON.stringify(data.error) : "createPosition failed");
      throw new Error(errMsg);
    }
    return Response.json({
      ok:          true,
      case:        4,
      newRangePct,
      livePrice:   livePrice4,
      minPrice:    minPrice.toFixed(0),
      maxPrice:    maxPrice.toFixed(0),
      createResult: data,
    });
  } catch (e) {
    const msg = e?.message ?? e?.shortMessage ?? String(e);
    await sendErrorEmail(
      "[CryptoYieldTracker] Erreur — Cas 4 création position",
      `Prix ETH : $${livePrice4}\nRange    : ${newRangePct}%\nMin      : $${minPrice.toFixed(0)}\nMax      : $${maxPrice.toFixed(0)}\n\nErreur : ${msg}`
    );
    return Response.json({ error: msg }, { status: 500 });
  }
}
