import { neon } from "@neondatabase/serverless";

export const runtime     = "nodejs";
export const maxDuration = 300;

const sql = neon(process.env.DATABASE_URL);


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

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const { forceCase, priceOverride } = body;

  if (forceCase === 1) return handleCase1(priceOverride);
  if (forceCase === 4) return handleCase4(priceOverride);

  return Response.json({ skipped: true, reason: `Cas ${forceCase} non implémenté` });
}

async function handleCase1(priceOverride) {
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  if (!base) return Response.json({ error: "APP_URL non configuré" }, { status: 500 });

  // Validation prix (valeur raisonnable pour l'ETH)
  const currentPrice = parseFloat(priceOverride);
  if (!currentPrice || isNaN(currentPrice) || currentPrice < 100 || currentPrice > 100000)
    return Response.json({ skipped: true, reason: "Prix ETH invalide ou hors limites (100–100 000)" });

  // 1. Vérifier position ouverte en DB
  let lastPos;
  try {
    const rows = await sql`
      SELECT usdc_placed, range_pct, range_min FROM lp_events
      WHERE action1 = 'CREATE_OK' AND (action2 IS NULL OR action2 != 'CLOSE_OK')
      ORDER BY created_at DESC LIMIT 1
    `;
    if (rows.length === 0)
      return Response.json({ skipped: true, reason: "Aucune position ouverte en DB" });
    lastPos = rows[0];
  } catch (e) {
    return Response.json({ error: `DB check failed: ${e.message}` }, { status: 500 });
  }

  const usdcPlaced = parseFloat(lastPos.usdc_placed);
  const rangePct   = parseFloat(lastPos.range_pct);
  const rangeMin   = parseFloat(lastPos.range_min);
  if (!usdcPlaced || isNaN(usdcPlaced) || !rangePct || isNaN(rangePct))
    return Response.json({ skipped: true, reason: "Données position invalides en DB" });

  if (!isNaN(rangeMin) && currentPrice >= rangeMin)
    return Response.json({ skipped: true, reason: `Prix ETH $${currentPrice} >= borne basse $${rangeMin} — pas hors range bas` });

  const newRangePct = rangePct * 1.5;
  const sqrtRatio   = Math.sqrt(1 + newRangePct / 100);
  const minPrice    = currentPrice / sqrtRatio;
  const maxPrice    = currentPrice * sqrtRatio;

  // 2. Fermer la position actuelle
  let closeData;
  try {
    const res = await fetch(`${base}/api/closePositions`, {
      method: "POST",
      signal: AbortSignal.timeout(240000),
    });
    closeData = await res.json();
    if (!res.ok) throw new Error(closeData.error ?? "close failed");
  } catch (e) {
    return Response.json({ error: `closePositions failed: ${e.message}` }, { status: 500 });
  }

  // 3. Créer nouvelle position 80% WETH / 20% USDC
  try {
    const res = await fetch(`${base}/api/createPosition`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        amountUSDC:  usdcPlaced,
        minPrice,
        maxPrice,
        currentPrice,
        targetRatio: 0.80,
        poolNum:     2,
      }),
      signal: AbortSignal.timeout(240000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "createPosition failed");
    return Response.json({
      ok:           true,
      case:         1,
      newRangePct,
      minPrice:     minPrice.toFixed(0),
      maxPrice:     maxPrice.toFixed(0),
      usdcPlaced,
      closeResult:  closeData,
      createResult: data,
    });
  } catch (e) {
    return Response.json({ case: 1, closeResult: closeData, error: `createPosition failed: ${e.message}` }, { status: 500 });
  }
}

async function handleCase4(priceOverride) {
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  if (!base) return Response.json({ error: "APP_URL non configuré" }, { status: 500 });

  const currentPrice = parseFloat(priceOverride);
  if (!currentPrice || isNaN(currentPrice))
    return Response.json({ error: "priceOverride requis" }, { status: 400 });

  // 1. Vérifier que la dernière ligne CREATE_OK est fermée (action2 = 'CLOSE_OK')
  try {
    const rows = await sql`
      SELECT action2 FROM lp_events
      WHERE action1 = 'CREATE_OK'
      ORDER BY created_at DESC LIMIT 1
    `;
    if (rows.length === 0 || rows[0].action2 !== "CLOSE_OK")
      return Response.json({ skipped: true, reason: "Dernière position non fermée ou inexistante" });
  } catch (e) {
    return Response.json({ error: `DB check failed: ${e.message}` }, { status: 500 });
  }

  // 2. Range via ATR
  let newRangePct;
  try {
    const res = await fetch(`${base}/api/atr`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const atr = await res.json();
    newRangePct = atr.range2x;
  } catch (e) {
    return Response.json({ error: `atr failed: ${e.message}` }, { status: 500 });
  }

  const sqrtRatio = Math.sqrt(1 + newRangePct / 100);
  const minPrice  = currentPrice / sqrtRatio;
  const maxPrice  = currentPrice * sqrtRatio;

  // 3. Créer nouvelle position 50/50 — 100 USDC
  try {
    const res = await fetch(`${base}/api/createPosition`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        amountUSDC:  100,
        minPrice,
        maxPrice,
        currentPrice,
        targetRatio: 0.5,
        poolNum:     2,
      }),
      signal: AbortSignal.timeout(240000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "createPosition failed");
    return Response.json({
      ok:          true,
      case:        4,
      newRangePct,
      minPrice:    minPrice.toFixed(0),
      maxPrice:    maxPrice.toFixed(0),
      createResult: data,
    });
  } catch (e) {
    await sendErrorEmail(
      "[CryptoYieldTracker] Erreur — Cas 4 création position",
      `Prix ETH : $${currentPrice}\nRange    : ${newRangePct}%\nMin      : $${minPrice.toFixed(0)}\nMax      : $${maxPrice.toFixed(0)}\n\nErreur : ${e.message}`
    );
    return Response.json({ error: e.message }, { status: 500 });
  }
}
