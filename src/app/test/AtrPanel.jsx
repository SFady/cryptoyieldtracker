"use client";

import { useEffect, useState, useCallback, useRef } from "react";

const REFRESH_INTERVAL = 5 * 60 * 1000;

const VOLATILITY_COLOR = {
  "Calme":        "#00e5a0",
  "Normal":       "#a477ff",
  "Agité":        "#f0b429",
  "Très volatile":"#c97070",
};

export default function AtrPanel() {
  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [lastFetch, setLastFetch] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showClose,  setShowClose]  = useState(false);

  const fetchAtr = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch("/api/atr");
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setData(json);
      setLastFetch(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAtr();
    const id = setInterval(fetchAtr, REFRESH_INTERVAL);
    return () => clearInterval(id);
  }, [fetchAtr]);

  const vColor = data ? (VOLATILITY_COLOR[data.volatility] ?? "#aaaacc") : "#aaaacc";

  return (
    <div style={{ maxWidth: 480 }}>

      {/* Prix + ATR */}
      <div style={{
        background: "rgba(10,10,30,0.7)",
        border: "1px solid rgba(124,77,255,0.25)",
        borderRadius: 12,
        padding: "16px 20px",
        marginBottom: 12,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}>
        <div>
          <div style={{ fontFamily: "monospace", fontSize: "0.65rem", color: "#6666aa", letterSpacing: "1.5px", marginBottom: 4 }}>
            WETH / USDC — BASE
          </div>
          <div style={{ fontFamily: "monospace", fontSize: "1.5rem", fontWeight: 700, color: "#eaf6ff" }}>
            {loading ? "—" : data ? `$${data.price.toLocaleString("en-US")}` : "—"}
          </div>
          {data && (
            <div style={{ fontFamily: "monospace", fontSize: "0.75rem", color: "#9988cc", marginTop: 4 }}>
              ATR({data.periods}) = <span style={{ color: "#eaf6ff" }}>${data.atr}</span>
              <span style={{ color: vColor, marginLeft: 10, fontWeight: 700 }}>
                {data.volatility}
              </span>
            </div>
          )}
        </div>
        <button
          onClick={fetchAtr}
          disabled={loading}
          style={{
            background: "rgba(124,77,255,0.15)",
            border: "1px solid rgba(124,77,255,0.3)",
            borderRadius: 6,
            color: loading ? "#555588" : "#a477ff",
            fontFamily: "monospace",
            fontSize: "0.7rem",
            padding: "6px 12px",
            cursor: loading ? "default" : "pointer",
            letterSpacing: "1px",
          }}
        >
          {loading ? "..." : "↺ REFRESH"}
        </button>
      </div>

      {error && (
        <div style={{
          color: "#c97070", background: "rgba(180,100,100,0.08)",
          border: "1px solid rgba(180,100,100,0.3)", borderRadius: 8,
          padding: "12px 16px", fontFamily: "monospace", fontSize: "0.85rem", marginBottom: 12,
        }}>
          ⚠ {error}
        </div>
      )}

      {data && (
        <>
          {/* Tableau volatilité */}
          <div style={{
            background: "rgba(18,18,45,0.95)",
            border: "1px solid rgba(124,77,255,0.2)",
            borderRadius: 12,
            overflow: "hidden",
            marginBottom: 12,
          }}>
            <div style={{
              display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
              padding: "8px 18px",
              background: "rgba(124,77,255,0.08)",
              borderBottom: "1px solid rgba(124,77,255,0.15)",
              fontFamily: "monospace", fontSize: "0.65rem", letterSpacing: "1.5px",
              textTransform: "uppercase", color: "#9988cc", fontWeight: 600,
            }}>
              <span>Volatilité</span>
              <span style={{ textAlign: "center" }}>ATR</span>
              <span style={{ textAlign: "right" }}>Range (×2)</span>
            </div>

            {[
              { label: "Calme",         atr: "$80",  range: "~7%"  },
              { label: "Normal",        atr: "$120", range: "~10%" },
              { label: "Agité",         atr: "$200", range: "~17%" },
              { label: "Très volatile", atr: "$300", range: "~26%" },
            ].map(({ label, atr, range }) => {
              const isCurrent = label === data.volatility;
              const color = VOLATILITY_COLOR[label];
              return (
                <div
                  key={label}
                  style={{
                    display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
                    padding: "11px 18px",
                    borderBottom: "1px solid rgba(255,255,255,0.03)",
                    background: isCurrent ? `${color}0f` : "transparent",
                    borderLeft: isCurrent ? `3px solid ${color}` : "3px solid transparent",
                  }}
                >
                  <span style={{ fontFamily: "monospace", fontSize: "0.85rem", fontWeight: isCurrent ? 700 : 400, color: isCurrent ? color : "#9988cc" }}>
                    {label}
                  </span>
                  <span style={{ fontFamily: "monospace", fontSize: "0.85rem", color: isCurrent ? "#eaf6ff" : "#6666aa", textAlign: "center" }}>
                    {isCurrent ? `$${data.atr}` : atr}
                  </span>
                  <span style={{ fontFamily: "monospace", fontSize: "0.85rem", fontWeight: isCurrent ? 700 : 400, color: isCurrent ? color : "#6666aa", textAlign: "right",
                    textShadow: isCurrent ? `0 0 10px ${color}66` : "none",
                  }}>
                    {isCurrent ? `${data.range2x}%` : range}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Bouton créer position */}
          <button
            onClick={() => setShowCreate(v => !v)}
            style={{
              width: "100%",
              padding: "13px",
              marginBottom: 12,
              background: showCreate ? "rgba(0,229,160,0.08)" : "rgba(0,229,160,0.12)",
              border: "1px solid rgba(0,229,160,0.35)",
              borderRadius: 10,
              color: "#00e5a0",
              fontFamily: "monospace",
              fontSize: "0.85rem",
              fontWeight: 700,
              letterSpacing: "1px",
              cursor: "pointer",
            }}
          >
            {showCreate ? "✕ ANNULER" : "+ CRÉER LA POSITION"}
          </button>

          {/* Panneau de création */}
          {showCreate && (
            <CreatePanel data={data} onClose={() => setShowCreate(false)} />
          )}

          {/* Bouton fermer tout */}
          <button
            onClick={() => { setShowClose(v => !v); setShowCreate(false); }}
            style={{
              width: "100%",
              padding: "13px",
              marginBottom: 12,
              background: showClose ? "rgba(201,112,112,0.08)" : "rgba(201,112,112,0.06)",
              border: "1px solid rgba(201,112,112,0.35)",
              borderRadius: 10,
              color: "#c97070",
              fontFamily: "monospace",
              fontSize: "0.85rem",
              fontWeight: 700,
              letterSpacing: "1px",
              cursor: "pointer",
            }}
          >
            {showClose ? "✕ ANNULER" : "⬛ TOUT FERMER → USDC"}
          </button>

          {showClose && <ClosePanel />}

          <div style={{ fontFamily: "monospace", fontSize: "0.65rem", color: "#44446a", textAlign: "right" }}>
            {lastFetch ? lastFetch.toLocaleTimeString("fr-FR") : "—"} · {data.candleCount} bougies · {data.interval}
          </div>
        </>
      )}

      <TestRebalanceSection />
      <HyperliquidShortSection />
      <HyperliquidCancelAllSection />
      <DiversSection />
    </div>
  );
}

const REBALANCE_CASES = [
  { num: 1, label: "CAS 1 — Hors range bas",       color: "#c97070" },
  { num: 2, label: "CAS 2 — Hors range haut",      color: "#f0b429" },
  { num: 3, label: "CAS 3 — In range > 6h",        color: "#a477ff" },
  { num: 4, label: "CAS 4 — Aucune position",      color: "#556688" },
  { num: 5, label: "CAS 5 — Collect auto 7h–8h",  color: "#f97316" },
  { num: 6, label: "CAS 6 — Collect manuel",       color: "#64b4ff" },
  { num: 7, label: "CAS 7 — Restake NFT",          color: "#00c9a7" },
];

function TestRebalanceSection() {
  const [poolNum,    setPoolNum]    = useState(2);
  const [status,     setStatus]     = useState({});
  const [results,    setResults]    = useState({});
  const [confirming, setConfirming] = useState({});
  const [lastRow,    setLastRow]    = useState(undefined);
  const [tokenId7,   setTokenId7]   = useState(() => {
    try { return localStorage.getItem("cas7-tokenId") ?? ""; } catch { return ""; }
  });
  const timers = useRef({});

  useEffect(() => {
    fetch("/api/lpStatus")
      .then(r => r.json())
      .then(d => setLastRow(d.lastRow ?? null))
      .catch(() => setLastRow(null));
  }, []);

  const hasError = lastRow &&
    lastRow.action1 !== "FEE_COLLECT" &&
    ((lastRow.action1 && lastRow.action1.includes("ERR")) ||
     (lastRow.action2 && lastRow.action2.includes("ERR")));

  const [resetting, setResetting] = useState(false);
  async function resetError() {
    setResetting(true);
    try {
      await fetch("/api/reset-error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolNum }),
      });
      // Ne pas re-fetcher le DB (toujours ERR) — null débloque l'UI, l'API Redis est la vraie gate
      setLastRow(null);
      setStatus({});
      setResults({});
    } catch (_) {}
    setResetting(false);
  }

  function handleClick(caseNum) {
    if (status[caseNum] === "loading") return;
    // Cases 7 et 8 sont des actions de recovery — bypass du check erreur côté client
    if (hasError && caseNum !== 7 && caseNum !== 8) {
      const reason = lastRow.error_msg
        ? lastRow.error_msg.slice(0, 120)
        : `${lastRow.action1}${lastRow.action2 ? " / " + lastRow.action2 : ""}`;
      setResults(r => ({ ...r, [caseNum]: `⚠ Bloqué — erreur détectée en base :\n${reason}` }));
      setStatus(s => ({ ...s, [caseNum]: "error" }));
      return;
    }
    if (!confirming[caseNum]) {
      setConfirming(c => ({ ...c, [caseNum]: true }));
      timers.current[caseNum] = setTimeout(() => {
        setConfirming(c => ({ ...c, [caseNum]: false }));
      }, 3000);
    } else {
      clearTimeout(timers.current[caseNum]);
      setConfirming(c => ({ ...c, [caseNum]: false }));
      trigger(caseNum);
    }
  }

  async function trigger(caseNum) {
    setStatus(s => ({ ...s, [caseNum]: "loading" }));
    setResults(r => ({ ...r, [caseNum]: "" }));
    try {
      const body = { forceCase: caseNum, poolNum };
      if (caseNum === 7 && tokenId7.trim()) {
        body.overrideTokenId = tokenId7.trim();
        try { localStorage.setItem("cas7-tokenId", tokenId7.trim()); } catch {}
      }
      const res  = await fetch("/api/autoRebalance", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      const json = await res.json();
      setStatus(s => ({ ...s, [caseNum]: res.ok && json.ok !== false ? "ok" : "error" }));
      setResults(r => ({ ...r, [caseNum]: JSON.stringify(json, null, 2) }));
      // Cas de recovery : si succès, débloquer l'UI sans attendre un refresh DB
      if ((caseNum === 7 || caseNum === 8) && res.ok && json.ok) setLastRow(null);
    } catch (e) {
      setStatus(s => ({ ...s, [caseNum]: "error" }));
      setResults(r => ({ ...r, [caseNum]: e.message }));
    }
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontFamily: "monospace", fontSize: "0.65rem", color: "#6666aa", letterSpacing: "1.5px", textTransform: "uppercase" }}>
          Tests Rebalance
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {[2, 3].map(n => (
            <button key={n} onClick={() => { setPoolNum(n); setStatus({}); setResults({}); }}
              style={{
                fontFamily: "monospace", fontSize: "0.65rem", fontWeight: 700,
                padding: "3px 12px", borderRadius: 4, cursor: "pointer",
                background: poolNum === n ? "rgba(124,77,255,0.25)" : "transparent",
                border: `1px solid ${poolNum === n ? "rgba(124,77,255,0.6)" : "rgba(124,77,255,0.2)"}`,
                color: poolNum === n ? "#c4a6ff" : "#666699",
              }}>
              Pool {n}
            </button>
          ))}
          <button onClick={resetError} disabled={resetting} style={{
            fontFamily: "monospace", fontSize: "0.6rem", fontWeight: 700,
            padding: "3px 10px", borderRadius: 4, cursor: resetting ? "default" : "pointer",
            background: "transparent",
            border: "1px solid rgba(180,100,100,0.35)",
            color: resetting ? "#664444" : "#aa5555",
          }}>
            {resetting ? "..." : "↺ Reset err"}
          </button>
        </div>
      </div>

      {REBALANCE_CASES.map(({ num, label, color }) => {
        const isLoading    = status[num] === "loading";
        const isConfirming = confirming[num];
        const btnColor     = isConfirming ? "#f0b429" : color;
        const btnLabel     = isLoading ? "..." : isConfirming ? "⚠ CONFIRMER ?" : "▶ LANCER";

        return (
          <div key={num} style={{
            background: "rgba(18,18,45,0.95)",
            border: `1px solid ${color}33`,
            borderRadius: 10,
            overflow: "hidden",
            marginBottom: 8,
          }}>
            <div style={{
              padding: "7px 14px",
              background: `${color}0d`,
              borderBottom: `1px solid ${color}22`,
              fontFamily: "monospace", fontSize: "0.65rem",
              letterSpacing: "1.5px", textTransform: "uppercase",
              color, fontWeight: 600,
            }}>
              {label}
            </div>

            <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
              {num === 7 && (
                <input
                  value={tokenId7}
                  onChange={e => setTokenId7(e.target.value)}
                  placeholder="TokenId (optionnel — sinon DB)"
                  style={{
                    fontFamily: "monospace", fontSize: "0.72rem",
                    padding: "6px 10px", borderRadius: 5,
                    background: "rgba(0,201,167,0.07)",
                    border: "1px solid rgba(0,201,167,0.3)",
                    color: "#00c9a7", outline: "none", width: "100%", boxSizing: "border-box",
                  }}
                />
              )}
              <button
                onClick={() => handleClick(num)}
                disabled={isLoading}
                style={{
                  padding: "9px 16px",
                  background: isConfirming ? "rgba(240,180,41,0.15)" : isLoading ? `${color}11` : `${color}22`,
                  border: `1px solid ${btnColor}66`,
                  borderRadius: 6,
                  color: isLoading ? `${btnColor}66` : btnColor,
                  fontFamily: "monospace",
                  fontSize: "0.75rem",
                  fontWeight: 700,
                  letterSpacing: "1px",
                  cursor: isLoading ? "default" : "pointer",
                  transition: "all 0.15s",
                }}
              >
                {btnLabel}
              </button>

              {results[num] && (
                <pre style={{
                  fontFamily: "monospace",
                  fontSize: "0.7rem",
                  color: status[num] === "ok" ? "#00e5a0" : "#c97070",
                  background: "rgba(0,0,0,0.3)",
                  border: `1px solid ${status[num] === "ok" ? "rgba(0,229,160,0.2)" : "rgba(180,100,100,0.2)"}`,
                  borderRadius: 6,
                  padding: "10px 12px",
                  margin: 0,
                  overflowX: "auto",
                  maxHeight: 200,
                  overflowY: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}>
                  {results[num]}
                </pre>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ClosePanel() {
  const [status, setStatus] = useState(null);
  const [msg,    setMsg]    = useState("");

  async function handleClose() {
    setStatus("loading");
    setMsg("");
    try {
      const res  = await fetch("/api/closePositions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ noTransfer: true }) });
      const json = await res.json();
      if (json.error) throw new Error(json.error);

      // Fermer aussi les positions Hyperliquid (pool 2)
      try {
        const hlRes = await fetch("/api/hyperliquid-cancel-all", { method: "POST" });
        const hlJson = await hlRes.json();
        if (!hlRes.ok) throw new Error(hlJson?.error ?? JSON.stringify(hlJson));
      } catch (hlErr) {
        setStatus("ok");
        setMsg(`LP fermée ✓ — Hyperliquid : ${hlErr.message}`);
        return;
      }

      setStatus("ok");
      setMsg(json.message);
    } catch (e) {
      setStatus("error");
      setMsg(e.message);
    }
  }

  return (
    <div style={{
      background: "rgba(18,18,45,0.98)",
      border: "1px solid rgba(201,112,112,0.25)",
      borderRadius: 12,
      overflow: "hidden",
      marginBottom: 12,
    }}>
      <div style={{
        padding: "8px 18px",
        background: "rgba(201,112,112,0.06)",
        borderBottom: "1px solid rgba(201,112,112,0.15)",
        fontFamily: "monospace", fontSize: "0.65rem", letterSpacing: "1.5px",
        textTransform: "uppercase", color: "#c97070", fontWeight: 600,
      }}>
        Fermer toutes les positions — WETH / USDC
      </div>

      <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{
          fontFamily: "monospace", fontSize: "0.8rem", color: "#c97070",
          background: "rgba(201,112,112,0.07)",
          border: "1px solid rgba(201,112,112,0.2)",
          borderRadius: 8, padding: "10px 14px", lineHeight: 1.6,
        }}>
          ⚠ Retire toutes vos positions WETH/USDC du staking et du LP,
          collecte les fees accumulées, et convertit tout en USDC.
        </div>

        {msg && (
          <div style={{
            fontFamily: "monospace", fontSize: "0.8rem",
            color: status === "ok" ? "#00e5a0" : "#c97070",
            background: status === "ok" ? "rgba(0,229,160,0.07)" : "rgba(180,100,100,0.08)",
            border: `1px solid ${status === "ok" ? "rgba(0,229,160,0.25)" : "rgba(180,100,100,0.25)"}`,
            borderRadius: 6, padding: "10px 14px",
          }}>
            {status === "ok" ? "✓ " : "⚠ "}{msg}
          </div>
        )}

        <button
          onClick={handleClose}
          disabled={status === "loading" || status === "ok"}
          style={{
            padding: "12px",
            background: status === "loading" || status === "ok"
              ? "rgba(201,112,112,0.05)"
              : "rgba(201,112,112,0.15)",
            border: "1px solid rgba(201,112,112,0.4)",
            borderRadius: 8,
            color: status === "loading" || status === "ok" ? "#663333" : "#c97070",
            fontFamily: "monospace",
            fontSize: "0.85rem",
            fontWeight: 700,
            letterSpacing: "1px",
            cursor: status === "loading" || status === "ok" ? "default" : "pointer",
          }}
        >
          {status === "loading" ? "FERMETURE EN COURS..." : status === "ok" ? "✓ TERMINÉ" : "CONFIRMER — TOUT FERMER"}
        </button>
      </div>
    </div>
  );
}

function optimalWethFraction(price, minP, maxP) {
  if (price <= minP) return 1;
  if (price >= maxP) return 0;
  const sqrtP  = Math.sqrt(price);
  const sqrtPa = Math.sqrt(minP);
  const sqrtPb = Math.sqrt(maxP);
  const val0 = sqrtP - price / sqrtPb;
  const val1 = sqrtP - sqrtPa;
  if (val0 + val1 <= 0) return 0.5;
  return val0 / (val0 + val1);
}

// Trouve le centre du range tel que optimalWethFraction(P, C/(1+h), C*(1+h)) = targetRatio
// Centre plus haut que P → prix en bas du range → plus de WETH ; plus bas → plus d'USDC
function findCenterForRatio(targetRatio, P, halfFrac) {
  const h = halfFrac;
  if (targetRatio >= 1) return P * (1 + h); // prix exactement à la borne basse → 100% WETH
  if (targetRatio <= 0) return P / (1 + h); // prix exactement à la borne haute → 100% USDC
  let lo = P / (1 + h) * 1.0001;
  let hi = P * (1 + h) * 0.9999;
  for (let i = 0; i < 60; i++) {
    const C = Math.sqrt(lo * hi);
    const r = optimalWethFraction(P, C / (1 + h), C * (1 + h));
    if (r < targetRatio) lo = C;
    else hi = C;
  }
  return Math.sqrt(lo * hi);
}

function CreatePanel({ data }) {
  const [amount, setAmount]           = useState("");
  const [multiplier, setMultiplier]   = useState("2.0");
  const [customRange, setCustomRange] = useState("");
  const [wethPct, setWethPct]         = useState(50);
  const [status, setStatus]           = useState(null);
  const [txMsg, setTxMsg]             = useState("");
  const [livePrice, setLivePrice]     = useState(null);
  const [priceStale, setPriceStale]   = useState(false);

  const fetchLivePrice = useCallback(async () => {
    try {
      const res  = await fetch("/api/livePrice");
      const json = await res.json();
      if (json.price) {
        setLivePrice(json.price);
        setPriceStale(false);
      }
    } catch (_) {
      setPriceStale(true);
    }
  }, []);

  useEffect(() => {
    fetchLivePrice();
    const id = setInterval(fetchLivePrice, 15_000);
    return () => clearInterval(id);
  }, [fetchLivePrice]);

  const basePrice = livePrice ?? data.price;
  const atrRange  = (data.atrPct * parseFloat(multiplier)).toFixed(2);
  const rangePct  = customRange !== "" && !isNaN(parseFloat(customRange)) && parseFloat(customRange) > 0
    ? parseFloat(customRange)
    : parseFloat(atrRange);
  const halfFrac    = rangePct / 200;
  const rangeCenter = findCenterForRatio(wethPct / 100, basePrice, halfFrac);
  const minPrice    = (rangeCenter / (1 + halfFrac)).toFixed(2);
  const maxPrice    = (rangeCenter * (1 + halfFrac)).toFixed(2);

  async function handleCreate() {
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      setTxMsg("Montant invalide."); setStatus("error"); return;
    }
    setStatus("loading");
    setTxMsg("");
    try {
      const res = await fetch("/api/createPosition", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountUSDC:   parseFloat(amount),
          minPrice:     parseFloat(minPrice),
          maxPrice:     parseFloat(maxPrice),
          currentPrice: basePrice,
          rangePercent: rangePct,
          targetRatio:  wethPct / 100,
          poolNum:      3,
        }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setStatus("ok");
      setTxMsg(json.message ?? "Position créée.");
    } catch (e) {
      setStatus("error");
      setTxMsg(e.message);
    }
  }

  const inputStyle = {
    width: "100%",
    background: "rgba(10,10,30,0.8)",
    border: "1px solid rgba(124,77,255,0.3)",
    borderRadius: 6,
    color: "#eaf6ff",
    fontFamily: "monospace",
    fontSize: "0.9rem",
    padding: "10px 14px",
    outline: "none",
    boxSizing: "border-box",
  };

  return (
    <div style={{
      background: "rgba(18,18,45,0.98)",
      border: "1px solid rgba(0,229,160,0.25)",
      borderRadius: 12,
      overflow: "hidden",
      marginBottom: 12,
    }}>
      <div style={{
        padding: "8px 18px",
        background: "rgba(0,229,160,0.06)",
        borderBottom: "1px solid rgba(0,229,160,0.15)",
        fontFamily: "monospace", fontSize: "0.65rem", letterSpacing: "1.5px",
        textTransform: "uppercase", color: "#00e5a0", fontWeight: 600,
      }}>
        Nouvelle position — WETH / USDC
      </div>

      <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Prix on-chain live */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          background: "rgba(0,0,0,0.25)",
          border: `1px solid ${priceStale ? "rgba(201,112,112,0.3)" : "rgba(0,229,160,0.2)"}`,
          borderRadius: 8, padding: "8px 14px",
        }}>
          <div>
            <div style={{ fontFamily: "monospace", fontSize: "0.6rem", color: "#6666aa", letterSpacing: "1px", marginBottom: 2 }}>
              PRIX ON-CHAIN <span style={{ color: priceStale ? "#c97070" : "#00e5a0" }}>● {priceStale ? "STALE" : "LIVE"}</span>
            </div>
            <div style={{ fontFamily: "monospace", fontSize: "1.1rem", fontWeight: 700, color: "#eaf6ff" }}>
              {livePrice ? `$${livePrice.toLocaleString("en-US")}` : "—"}
              {livePrice && Math.abs(livePrice - data.price) > 1 && (
                <span style={{ fontSize: "0.7rem", color: "#f0b429", marginLeft: 8 }}>
                  (UI: ${data.price.toLocaleString("en-US")})
                </span>
              )}
            </div>
          </div>
          <button onClick={fetchLivePrice} style={{
            background: "transparent", border: "1px solid rgba(0,229,160,0.2)",
            borderRadius: 5, color: "#00e5a0", fontFamily: "monospace",
            fontSize: "0.7rem", padding: "4px 10px", cursor: "pointer",
          }}>↺</button>
        </div>

        {/* Multiplicateur */}
        <div>
          <div style={{ fontFamily: "monospace", fontSize: "0.65rem", color: "#6666aa", letterSpacing: "1px", marginBottom: 6 }}>
            MULTIPLICATEUR ATR
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {["1.0", "2.0", "2.5"].map(m => (
              <button
                key={m}
                onClick={() => setMultiplier(m)}
                style={{
                  flex: 1,
                  padding: "7px",
                  background: multiplier === m ? "rgba(0,229,160,0.15)" : "rgba(124,77,255,0.08)",
                  border: `1px solid ${multiplier === m ? "rgba(0,229,160,0.4)" : "rgba(124,77,255,0.2)"}`,
                  borderRadius: 6,
                  color: multiplier === m ? "#00e5a0" : "#9988cc",
                  fontFamily: "monospace",
                  fontSize: "0.8rem",
                  fontWeight: multiplier === m ? 700 : 400,
                  cursor: "pointer",
                }}
              >
                ×{m}
              </button>
            ))}
          </div>
        </div>

        {/* Résumé range */}
        {(() => {
          const minP = parseFloat(minPrice);
          const maxP = parseFloat(maxPrice);
          const pctPos = Math.max(0, Math.min(100, (Math.log(basePrice / minP) / Math.log(maxP / minP)) * 100));
          return (
            <div style={{
              background: "rgba(0,0,0,0.2)",
              border: "1px solid rgba(124,77,255,0.15)",
              borderRadius: 8,
              padding: "10px 14px",
            }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, textAlign: "center" }}>
                <div>
                  <div style={{ fontFamily: "monospace", fontSize: "0.6rem", color: "#6666aa", marginBottom: 2 }}>MIN</div>
                  <div style={{ fontFamily: "monospace", fontSize: "0.85rem", fontWeight: 700, color: "#c97070" }}>${Number(minPrice).toLocaleString("en-US")}</div>
                </div>
                <div>
                  <div style={{ fontFamily: "monospace", fontSize: "0.6rem", color: "#6666aa", marginBottom: 2 }}>RANGE</div>
                  <div style={{ fontFamily: "monospace", fontSize: "0.85rem", fontWeight: 700, color: "#eaf6ff" }}>{rangePct}%</div>
                </div>
                <div>
                  <div style={{ fontFamily: "monospace", fontSize: "0.6rem", color: "#6666aa", marginBottom: 2 }}>MAX</div>
                  <div style={{ fontFamily: "monospace", fontSize: "0.85rem", fontWeight: 700, color: "#00e5a0" }}>${Number(maxPrice).toLocaleString("en-US")}</div>
                </div>
              </div>
              {/* Barre indiquant où se trouve le prix actuel dans le range */}
              <div style={{ position: "relative", height: 14, marginTop: 8 }}>
                <div style={{ position: "absolute", top: 5, left: 0, right: 0, height: 4, background: "rgba(255,255,255,0.07)", borderRadius: 2 }} />
                <div style={{ position: "absolute", top: 5, left: 0, width: `${pctPos}%`, height: 4, background: "rgba(164,119,255,0.35)", borderRadius: 2 }} />
                <div style={{
                  position: "absolute", top: 1, left: `${pctPos}%`, transform: "translateX(-50%)",
                  width: 12, height: 12, borderRadius: 6,
                  background: "#a477ff", boxShadow: "0 0 8px rgba(164,119,255,0.9)",
                }} />
                <div style={{
                  position: "absolute", top: -2, left: `${pctPos}%`, transform: "translateX(-50%)",
                  fontFamily: "monospace", fontSize: "0.55rem", color: "#a477ff",
                  whiteSpace: "nowrap", marginTop: 14,
                }}>▲ PRIX</div>
              </div>
            </div>
          );
        })()}

        {/* Range % */}
        <div>
          <div style={{ fontFamily: "monospace", fontSize: "0.65rem", color: "#6666aa", letterSpacing: "1px", marginBottom: 6 }}>
            RANGE (%) <span style={{ color: "#44446a" }}>— ATR suggère {atrRange}%</span>
          </div>
          <input
            type="number"
            placeholder={atrRange}
            value={customRange}
            onChange={e => setCustomRange(e.target.value)}
            style={inputStyle}
          />
        </div>

        {/* Ratio WETH / USDC */}
        <div>
          <div style={{ fontFamily: "monospace", fontSize: "0.65rem", color: "#6666aa", letterSpacing: "1px", marginBottom: 6 }}>
            RATIO WETH / USDC
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            {[0, 20, 50, 80, 100].map(p => (
              <button key={p} onClick={() => setWethPct(p)} style={{
                flex: 1, padding: "5px 2px",
                background: wethPct === p ? "rgba(164,119,255,0.18)" : "rgba(124,77,255,0.07)",
                border: `1px solid ${wethPct === p ? "rgba(164,119,255,0.5)" : "rgba(124,77,255,0.2)"}`,
                borderRadius: 5, color: wethPct === p ? "#a477ff" : "#6666aa",
                fontFamily: "monospace", fontSize: "0.72rem", fontWeight: wethPct === p ? 700 : 400,
                cursor: "pointer",
              }}>
                {p}/{100 - p}
              </button>
            ))}
          </div>
          <div style={{ height: 6, borderRadius: 4, background: "rgba(255,255,255,0.07)", overflow: "hidden", marginBottom: 10 }}>
            <div style={{
              height: "100%", width: "100%", borderRadius: 4,
              background: `linear-gradient(90deg, #4488ff ${wethPct}%, #00e5a0 ${wethPct}%)`,
              transition: "all 0.2s",
            }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <div style={{ fontFamily: "monospace", fontSize: "0.6rem", color: "#4488ff", marginBottom: 4 }}>
                WETH — <strong>{wethPct}%</strong>
              </div>
              <input type="range" min={0} max={100} step={5} value={wethPct}
                onChange={e => setWethPct(Number(e.target.value))}
                style={{ width: "100%", accentColor: "#4488ff" }}
              />
            </div>
            <div>
              <div style={{ fontFamily: "monospace", fontSize: "0.6rem", color: "#00e5a0", marginBottom: 4 }}>
                USDC — <strong>{100 - wethPct}%</strong>
              </div>
              <input type="range" min={0} max={100} step={5} value={100 - wethPct}
                onChange={e => setWethPct(100 - Number(e.target.value))}
                style={{ width: "100%", accentColor: "#00e5a0" }}
              />
            </div>
          </div>
        </div>

        {/* Montant USDC */}
        <div>
          <div style={{ fontFamily: "monospace", fontSize: "0.65rem", color: "#6666aa", letterSpacing: "1px", marginBottom: 6 }}>
            MONTANT (USDC)
          </div>
          <input
            type="number"
            placeholder="ex: 1000"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            style={inputStyle}
          />
        </div>

        {/* Feedback */}
        {txMsg && (
          <div style={{
            fontFamily: "monospace", fontSize: "0.8rem",
            color: status === "ok" ? "#00e5a0" : "#c97070",
            background: status === "ok" ? "rgba(0,229,160,0.07)" : "rgba(180,100,100,0.08)",
            border: `1px solid ${status === "ok" ? "rgba(0,229,160,0.25)" : "rgba(180,100,100,0.25)"}`,
            borderRadius: 6,
            padding: "10px 14px",
          }}>
            {status === "ok" ? "✓ " : "⚠ "}{txMsg}
          </div>
        )}

        {/* Confirmer */}
        <button
          onClick={handleCreate}
          disabled={status === "loading"}
          style={{
            padding: "12px",
            background: status === "loading" ? "rgba(0,229,160,0.05)" : "rgba(0,229,160,0.15)",
            border: "1px solid rgba(0,229,160,0.4)",
            borderRadius: 8,
            color: status === "loading" ? "#336655" : "#00e5a0",
            fontFamily: "monospace",
            fontSize: "0.85rem",
            fontWeight: 700,
            letterSpacing: "1px",
            cursor: status === "loading" ? "default" : "pointer",
          }}
        >
          {status === "loading" ? "ENVOI EN COURS..." : "CONFIRMER LA POSITION"}
        </button>
      </div>
    </div>
  );
}

function DiversSection() {
  const [open,       setOpen]       = useState(false);
  const [expanded,   setExpanded]   = useState(null);
  const color = "#64b4ff";

  function toggleItem(key) {
    setExpanded(v => v === key ? null : key);
  }

  return (
    <div style={{ marginTop: 16 }}>
      <button
        onClick={() => { setOpen(v => !v); setExpanded(null); }}
        style={{
          width: "100%",
          padding: "11px 14px",
          background: open ? `${color}12` : `${color}08`,
          border: `1px solid ${color}44`,
          borderRadius: open ? "10px 10px 0 0" : 10,
          color,
          fontFamily: "monospace",
          fontSize: "0.75rem",
          fontWeight: 700,
          letterSpacing: "1px",
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>DIVERS</span>
        <span style={{ fontSize: "0.65rem", opacity: 0.7 }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{
          background: "rgba(18,18,45,0.97)",
          border: `1px solid ${color}33`,
          borderTop: "none",
          borderRadius: "0 0 10px 10px",
          overflow: "hidden",
        }}>
          <HlTransferAmountItem
            isOpen={expanded === "hl-transfer"}
            onToggle={() => toggleItem("hl-transfer")}
            borderBottom
          />
          <HlBridgeToBaseItem
            isOpen={expanded === "hl-bridge"}
            onToggle={() => toggleItem("hl-bridge")}
            borderBottom
          />
          <BaseToArbItem
            isOpen={expanded === "base-to-arb"}
            onToggle={() => toggleItem("base-to-arb")}
            borderBottom
          />
          <BaseToHlItem
            isOpen={expanded === "base-to-hl"}
            onToggle={() => toggleItem("base-to-hl")}
            borderBottom
          />
          <Pool2TotalItem
            isOpen={expanded === "pool2-total"}
            onToggle={() => toggleItem("pool2-total")}
            borderBottom
          />
          <StartItem
            isOpen={expanded === "start"}
            onToggle={() => toggleItem("start")}
          />
        </div>
      )}
    </div>
  );
}

function HlTransferAmountItem({ isOpen, onToggle, borderBottom }) {
  const [amount,     setAmount]     = useState("");
  const [confirming, setConfirming] = useState(false);
  const [status,     setStatus]     = useState(null);
  const [result,     setResult]     = useState(null);
  const timerRef = useRef(null);
  const color = "#64b4ff";

  function handleValidate() {
    if (!amount || parseFloat(amount) < 5) return;
    if (!confirming) {
      setConfirming(true);
      timerRef.current = setTimeout(() => setConfirming(false), 3000);
    } else {
      clearTimeout(timerRef.current);
      setConfirming(false);
      submit();
    }
  }

  async function submit() {
    setStatus("loading");
    setResult(null);
    try {
      const res  = await fetch("/api/hl-to-base", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ amount: parseFloat(amount) }),
      });
      const json = await res.json();
      setStatus(json.ok ? "ok" : json.pending ? "pending" : "error");
      setResult(json);
    } catch (e) {
      setStatus("error");
      setResult({ error: e.message });
    }
  }

  const isLoading = status === "loading";
  const btnColor  = confirming ? "#f0b429" : color;
  const btnLabel  = isLoading ? "..." : confirming ? "⚠ OK ?" : "Valider";

  return (
    <div style={{ borderBottom: borderBottom ? `1px solid ${color}11` : "none" }}>
      <div
        onClick={onToggle}
        style={{
          padding: "11px 14px",
          fontFamily: "monospace",
          fontSize: "0.8rem",
          color: isOpen ? color : "#9988cc",
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: isOpen ? `${color}08` : "transparent",
        }}
      >
        <span>hl-to-base</span>
        <span style={{ fontSize: "0.6rem", opacity: 0.6 }}>{isOpen ? "▲" : "▼"}</span>
      </div>

      {isOpen && (
        <div style={{ padding: "0 14px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontFamily: "monospace", fontSize: "0.6rem", color: "#44446a" }}>
            HL → Arbitrum → Base (tout-en-un, ~4 min max) · min $5
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="number"
              placeholder="Montant USDC"
              value={amount}
              onChange={e => { setAmount(e.target.value); setConfirming(false); setStatus(null); setResult(null); }}
              disabled={isLoading}
              style={{
                flex: 1,
                fontFamily: "monospace",
                fontSize: "0.8rem",
                padding: "7px 10px",
                borderRadius: 5,
                background: `${color}08`,
                border: `1px solid ${color}33`,
                color: "#eaf6ff",
                outline: "none",
                opacity: isLoading ? 0.5 : 1,
              }}
            />
            <button
              onClick={handleValidate}
              disabled={isLoading || !amount || parseFloat(amount) < 5}
              style={{
                padding: "7px 14px",
                background: confirming ? "rgba(240,180,41,0.15)" : `${color}15`,
                border: `1px solid ${btnColor}66`,
                borderRadius: 5,
                color: (isLoading || !amount) ? `${btnColor}44` : btnColor,
                fontFamily: "monospace",
                fontSize: "0.75rem",
                fontWeight: 700,
                cursor: (isLoading || !amount) ? "default" : "pointer",
                whiteSpace: "nowrap",
                transition: "all 0.15s",
              }}
            >
              {btnLabel}
            </button>
          </div>

          {isLoading && (
            <div style={{ fontFamily: "monospace", fontSize: "0.7rem", color: "#f0b429" }}>
              ⏳ En cours... (peut prendre jusqu'à 4 min)
            </div>
          )}

          {result && (
            <pre style={{
              fontFamily: "monospace",
              fontSize: "0.75rem",
              color: status === "ok" ? "#00e5a0" : status === "pending" ? "#f0b429" : "#c97070",
              background: status === "ok" ? "rgba(0,229,160,0.06)" : "rgba(0,0,0,0.25)",
              border: `1px solid ${status === "ok" ? "rgba(0,229,160,0.2)" : "rgba(100,180,255,0.15)"}`,
              borderRadius: 6,
              padding: "12px 14px",
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 260,
              overflowY: "auto",
            }}>
              {status === "ok" ? "✓ " : status === "pending" ? "⏳ " : "⚠ "}{JSON.stringify(result, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function HyperliquidCancelAllSection() {
  const [status,     setStatus]     = useState(null);
  const [result,     setResult]     = useState(null);
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef(null);

  function handleClick() {
    if (status === "loading") return;
    if (!confirming) {
      setConfirming(true);
      timerRef.current = setTimeout(() => setConfirming(false), 3000);
    } else {
      clearTimeout(timerRef.current);
      setConfirming(false);
      submit();
    }
  }

  async function submit() {
    setStatus("loading");
    setResult(null);
    try {
      const res  = await fetch("/api/hyperliquid-cancel-all", { method: "POST" });
      const json = await res.json();
      setStatus(json.ok ? "ok" : "error");
      setResult(json);
    } catch (e) {
      setStatus("error");
      setResult({ error: e.message });
    }
  }

  const color    = "#ff5c5c";
  const btnColor = confirming ? "#f0b429" : color;
  const btnLabel = status === "loading" ? "..." : confirming ? "⚠ CONFIRMER ?" : "✕ Annuler ordres + fermer positions";

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{
        background: "rgba(18,18,45,0.95)",
        border: `1px solid ${color}33`,
        borderRadius: 10,
        overflow: "hidden",
      }}>
        <div style={{
          padding: "7px 14px",
          background: `${color}0d`,
          borderBottom: `1px solid ${color}22`,
          fontFamily: "monospace", fontSize: "0.65rem",
          letterSpacing: "1.5px", textTransform: "uppercase",
          color, fontWeight: 600,
        }}>
          CANCEL ORDERS + CLOSE POSITIONS — HYPERLIQUID
        </div>

        <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
          <button
            onClick={handleClick}
            disabled={status === "loading"}
            style={{
              padding: "9px 16px",
              background: confirming ? "rgba(240,180,41,0.15)" : status === "loading" ? `${color}11` : `${color}15`,
              border: `1px solid ${btnColor}66`,
              borderRadius: 6,
              color: status === "loading" ? `${btnColor}66` : btnColor,
              fontFamily: "monospace", fontSize: "0.75rem", fontWeight: 700, letterSpacing: "1px",
              cursor: status === "loading" ? "default" : "pointer",
              transition: "all 0.15s",
            }}
          >
            {btnLabel}
          </button>

          {result && (
            <pre style={{
              fontFamily: "monospace", fontSize: "0.7rem",
              color: status === "ok" ? "#00e5a0" : "#c97070",
              background: "rgba(0,0,0,0.3)",
              border: `1px solid ${status === "ok" ? "rgba(0,229,160,0.2)" : "rgba(180,100,100,0.2)"}`,
              borderRadius: 6, padding: "10px 12px", margin: 0,
              overflowX: "auto", maxHeight: 140, overflowY: "auto",
              whiteSpace: "pre-wrap", wordBreak: "break-word",
            }}>
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function HlBridgeToBaseItem({ isOpen, onToggle, borderBottom }) {
  const [amount,     setAmount]     = useState("");
  const [confirming, setConfirming] = useState(false);
  const [status,     setStatus]     = useState(null);
  const [result,     setResult]     = useState(null);
  const timerRef = useRef(null);
  const color = "#64b4ff";

  function handleValidate() {
    if (!amount || parseFloat(amount) <= 0) return;
    if (!confirming) {
      setConfirming(true);
      timerRef.current = setTimeout(() => setConfirming(false), 3000);
    } else {
      clearTimeout(timerRef.current);
      setConfirming(false);
      submit();
    }
  }

  async function submit() {
    setStatus("loading");
    setResult(null);
    try {
      const res  = await fetch("/api/hyperliquid-bridge-to-base", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ amount: parseFloat(amount) }),
      });
      const json = await res.json();
      setStatus(json.ok ? "ok" : "error");
      setResult(json);
    } catch (e) {
      setStatus("error");
      setResult({ error: e.message });
    }
  }

  const btnColor = confirming ? "#f0b429" : color;
  const btnLabel = status === "loading" ? "..." : confirming ? "⚠ OK ?" : "Valider";

  return (
    <div style={{ borderBottom: borderBottom ? `1px solid ${color}11` : "none" }}>
      <div
        onClick={onToggle}
        style={{
          padding: "11px 14px",
          fontFamily: "monospace",
          fontSize: "0.8rem",
          color: isOpen ? color : "#9988cc",
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: isOpen ? `${color}08` : "transparent",
        }}
      >
        <span>hyperliquid-bridge-to-base</span>
        <span style={{ fontSize: "0.6rem", opacity: 0.6 }}>{isOpen ? "▲" : "▼"}</span>
      </div>

      {isOpen && (
        <div style={{ padding: "0 14px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontFamily: "monospace", fontSize: "0.6rem", color: "#44446a" }}>
            Arbitrum → Base via Across · déclencher après réception du retrait HL
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="number"
              placeholder="Montant USDC"
              value={amount}
              onChange={e => { setAmount(e.target.value); setConfirming(false); setStatus(null); setResult(null); }}
              style={{
                flex: 1,
                fontFamily: "monospace",
                fontSize: "0.8rem",
                padding: "7px 10px",
                borderRadius: 5,
                background: `${color}08`,
                border: `1px solid ${color}33`,
                color: "#eaf6ff",
                outline: "none",
              }}
            />
            <button
              onClick={handleValidate}
              disabled={status === "loading" || !amount || parseFloat(amount) <= 0}
              style={{
                padding: "7px 14px",
                background: confirming ? "rgba(240,180,41,0.15)" : `${color}15`,
                border: `1px solid ${btnColor}66`,
                borderRadius: 5,
                color: status === "loading" || !amount ? `${btnColor}44` : btnColor,
                fontFamily: "monospace",
                fontSize: "0.75rem",
                fontWeight: 700,
                cursor: (status === "loading" || !amount) ? "default" : "pointer",
                whiteSpace: "nowrap",
                transition: "all 0.15s",
              }}
            >
              {btnLabel}
            </button>
          </div>

          {result && (
            <pre style={{
              fontFamily: "monospace",
              fontSize: "0.75rem",
              color: status === "ok" ? "#00e5a0" : "#c97070",
              background: status === "ok" ? "rgba(0,229,160,0.06)" : "rgba(180,100,100,0.08)",
              border: `1px solid ${status === "ok" ? "rgba(0,229,160,0.2)" : "rgba(180,100,100,0.2)"}`,
              borderRadius: 6,
              padding: "12px 14px",
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 260,
              overflowY: "auto",
            }}>
              {status === "ok" ? "✓ " : "⚠ "}{JSON.stringify(result, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function BaseToArbItem({ isOpen, onToggle }) {
  const [amount,     setAmount]     = useState("");
  const [confirming, setConfirming] = useState(false);
  const [status,     setStatus]     = useState(null);
  const [result,     setResult]     = useState(null);
  const timerRef = useRef(null);
  const color = "#64b4ff";

  function handleValidate() {
    if (!amount || parseFloat(amount) < 5) return;
    if (!confirming) {
      setConfirming(true);
      timerRef.current = setTimeout(() => setConfirming(false), 3000);
    } else {
      clearTimeout(timerRef.current);
      setConfirming(false);
      submit();
    }
  }

  async function submit() {
    setStatus("loading");
    setResult(null);
    try {
      const res  = await fetch("/api/base-to-arb", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ amount: parseFloat(amount) }),
      });
      const json = await res.json();
      setStatus(json.ok ? "ok" : "error");
      setResult(json);
    } catch (e) {
      setStatus("error");
      setResult({ error: e.message });
    }
  }

  const isLoading = status === "loading";
  const btnColor  = confirming ? "#f0b429" : color;
  const btnLabel  = isLoading ? "..." : confirming ? "⚠ OK ?" : "Valider";

  return (
    <div>
      <div
        onClick={onToggle}
        style={{
          padding: "11px 14px",
          fontFamily: "monospace",
          fontSize: "0.8rem",
          color: isOpen ? color : "#9988cc",
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: isOpen ? `${color}08` : "transparent",
        }}
      >
        <span>base-to-arb</span>
        <span style={{ fontSize: "0.6rem", opacity: 0.6 }}>{isOpen ? "▲" : "▼"}</span>
      </div>

      {isOpen && (
        <div style={{ padding: "0 14px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontFamily: "monospace", fontSize: "0.6rem", color: "#44446a" }}>
            USDC Base → wallet Arbitrum via Across · min $5
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="number"
              placeholder="Montant USDC"
              value={amount}
              onChange={e => { setAmount(e.target.value); setConfirming(false); setStatus(null); setResult(null); }}
              disabled={isLoading}
              style={{
                flex: 1,
                fontFamily: "monospace",
                fontSize: "0.8rem",
                padding: "7px 10px",
                borderRadius: 5,
                background: `${color}08`,
                border: `1px solid ${color}33`,
                color: "#eaf6ff",
                outline: "none",
                opacity: isLoading ? 0.5 : 1,
              }}
            />
            <button
              onClick={handleValidate}
              disabled={isLoading || !amount || parseFloat(amount) < 5}
              style={{
                padding: "7px 14px",
                background: confirming ? "rgba(240,180,41,0.15)" : `${color}15`,
                border: `1px solid ${btnColor}66`,
                borderRadius: 5,
                color: (isLoading || !amount || parseFloat(amount) < 5) ? `${btnColor}44` : btnColor,
                fontFamily: "monospace",
                fontSize: "0.75rem",
                fontWeight: 700,
                cursor: (isLoading || !amount || parseFloat(amount) < 5) ? "default" : "pointer",
                whiteSpace: "nowrap",
                transition: "all 0.15s",
              }}
            >
              {btnLabel}
            </button>
          </div>

          {isLoading && (
            <div style={{ fontFamily: "monospace", fontSize: "0.7rem", color: "#f0b429" }}>
              ⏳ Bridge en cours...
            </div>
          )}

          {result && (
            <pre style={{
              fontFamily: "monospace",
              fontSize: "0.75rem",
              color: status === "ok" ? "#00e5a0" : "#c97070",
              background: status === "ok" ? "rgba(0,229,160,0.06)" : "rgba(180,100,100,0.08)",
              border: `1px solid ${status === "ok" ? "rgba(0,229,160,0.2)" : "rgba(180,100,100,0.2)"}`,
              borderRadius: 6,
              padding: "12px 14px",
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 260,
              overflowY: "auto",
            }}>
              {status === "ok" ? "✓ " : "⚠ "}{JSON.stringify(result, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function BaseToHlItem({ isOpen, onToggle }) {
  const [amount,     setAmount]     = useState("");
  const [confirming, setConfirming] = useState(false);
  const [status,     setStatus]     = useState(null);
  const [result,     setResult]     = useState(null);
  const timerRef = useRef(null);
  const color = "#64b4ff";

  function handleValidate() {
    if (!amount || parseFloat(amount) < 5) return;
    if (!confirming) {
      setConfirming(true);
      timerRef.current = setTimeout(() => setConfirming(false), 3000);
    } else {
      clearTimeout(timerRef.current);
      setConfirming(false);
      submit();
    }
  }

  async function submit() {
    setStatus("loading");
    setResult(null);
    try {
      const res  = await fetch("/api/base-to-hl", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ amount: parseFloat(amount) }),
      });
      const json = await res.json();
      setStatus(json.ok ? "ok" : json.pending ? "pending" : "error");
      setResult(json);
    } catch (e) {
      setStatus("error");
      setResult({ error: e.message });
    }
  }

  const isLoading = status === "loading";
  const btnColor  = confirming ? "#f0b429" : color;
  const btnLabel  = isLoading ? "..." : confirming ? "⚠ OK ?" : "Valider";

  return (
    <div>
      <div
        onClick={onToggle}
        style={{
          padding: "11px 14px",
          fontFamily: "monospace",
          fontSize: "0.8rem",
          color: isOpen ? color : "#9988cc",
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: isOpen ? `${color}08` : "transparent",
        }}
      >
        <span>base-to-hl</span>
        <span style={{ fontSize: "0.6rem", opacity: 0.6 }}>{isOpen ? "▲" : "▼"}</span>
      </div>

      {isOpen && (
        <div style={{ padding: "0 14px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontFamily: "monospace", fontSize: "0.6rem", color: "#44446a" }}>
            USDC Base → Arbitrum → Hyperliquid (tout-en-un, ~4 min max) · min $5
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="number"
              placeholder="Montant USDC"
              value={amount}
              onChange={e => { setAmount(e.target.value); setConfirming(false); setStatus(null); setResult(null); }}
              disabled={isLoading}
              style={{
                flex: 1,
                fontFamily: "monospace",
                fontSize: "0.8rem",
                padding: "7px 10px",
                borderRadius: 5,
                background: `${color}08`,
                border: `1px solid ${color}33`,
                color: "#eaf6ff",
                outline: "none",
                opacity: isLoading ? 0.5 : 1,
              }}
            />
            <button
              onClick={handleValidate}
              disabled={isLoading || !amount || parseFloat(amount) < 5}
              style={{
                padding: "7px 14px",
                background: confirming ? "rgba(240,180,41,0.15)" : `${color}15`,
                border: `1px solid ${btnColor}66`,
                borderRadius: 5,
                color: (isLoading || !amount || parseFloat(amount) < 5) ? `${btnColor}44` : btnColor,
                fontFamily: "monospace",
                fontSize: "0.75rem",
                fontWeight: 700,
                cursor: (isLoading || !amount || parseFloat(amount) < 5) ? "default" : "pointer",
                whiteSpace: "nowrap",
                transition: "all 0.15s",
              }}
            >
              {btnLabel}
            </button>
          </div>

          {isLoading && (
            <div style={{ fontFamily: "monospace", fontSize: "0.7rem", color: "#f0b429" }}>
              ⏳ En cours... (peut prendre jusqu'à 4 min)
            </div>
          )}

          {result && (
            <pre style={{
              fontFamily: "monospace",
              fontSize: "0.75rem",
              color: status === "ok" ? "#00e5a0" : status === "pending" ? "#f0b429" : "#c97070",
              background: status === "ok" ? "rgba(0,229,160,0.06)" : "rgba(0,0,0,0.25)",
              border: `1px solid ${status === "ok" ? "rgba(0,229,160,0.2)" : "rgba(100,180,255,0.15)"}`,
              borderRadius: 6,
              padding: "12px 14px",
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 260,
              overflowY: "auto",
            }}>
              {status === "ok" ? "✓ " : status === "pending" ? "⏳ " : "⚠ "}{JSON.stringify(result, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function StartItem({ isOpen, onToggle }) {
  const [hlAmount,   setHlAmount]   = useState("");
  const [poolAmount, setPoolAmount] = useState("");
  const [leverage,   setLeverage]   = useState("4");
  const [confirming, setConfirming] = useState(false);
  const [status,     setStatus]     = useState(null);
  const [log,        setLog]        = useState([]);
  const timerRef = useRef(null);
  const color = "#00e5a0";

  function handleValidate() {
    if (!hlAmount || !poolAmount || parseFloat(hlAmount) <= 0 || parseFloat(poolAmount) <= 0) return;
    if (!confirming) {
      setConfirming(true);
      timerRef.current = setTimeout(() => setConfirming(false), 3000);
    } else {
      clearTimeout(timerRef.current);
      setConfirming(false);
      run();
    }
  }

  async function run() {
    setStatus("loading");
    setLog([]);

    try {
      // 1. ATR data
      const atrRes = await fetch("/api/atr");
      const atr    = await atrRes.json();
      if (atr.error) throw new Error(atr.error);

      const rangePct = atr.atrPct * 2.0;
      const halfFrac = rangePct / 200;
      const slPrice  = atr.price * (1 + halfFrac);
      const tpPrice  = atr.price / (1 + halfFrac);

      setLog(l => [...l, `ATR ${atr.atrPct}% × 2 → ${rangePct.toFixed(2)}% · SL $${slPrice.toFixed(1)} · TP $${tpPrice.toFixed(1)}`]);

      // 2. Short HL
      const shortRes = await fetch("/api/hyperliquid-short", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          sizeUsd:          parseFloat(hlAmount),
          leverage:         parseFloat(leverage) || 4,
          slPriceTrigger:   slPrice,
          tpPriceTrigger:   tpPrice,
        }),
      });
      const short = await shortRes.json();
      if (!short.ok) throw new Error(short.error ?? JSON.stringify(short));

      const avgPx = parseFloat(short.ioStatus?.filled?.avgPx ?? short.ethPrice);
      setLog(l => [...l, `Short @ $${avgPx} · ${short.sizeEth} ETH · levier ×${short.leverage}`]);

      // 3. Position pool — mêmes bornes que le short HL
      const minPrice = tpPrice;
      const maxPrice = slPrice;
      setLog(l => [...l, `Pool range $${minPrice.toFixed(2)} – $${maxPrice.toFixed(2)} · 50/50`]);

      const poolRes = await fetch("/api/createPosition", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          amountUSDC:   parseFloat(poolAmount),
          minPrice:     parseFloat(minPrice.toFixed(2)),
          maxPrice:     parseFloat(maxPrice.toFixed(2)),
          currentPrice: avgPx,
          rangePercent: rangePct,
          targetRatio:  0.5,
          poolNum:      2,
        }),
      });
      const pool = await poolRes.json();
      if (pool.error) throw new Error(pool.error);

      setLog(l => [...l, `Pool ouverte ✓`]);
      setStatus("ok");
    } catch (e) {
      setLog(l => [...l, `⚠ ${e.message}`]);
      setStatus("error");
    }
  }

  const isLoading = status === "loading";
  const btnColor  = confirming ? "#f0b429" : color;
  const btnLabel  = isLoading ? "..." : confirming ? "⚠ CONFIRMER ?" : "▶ START";

  return (
    <div>
      <div
        onClick={onToggle}
        style={{
          padding: "11px 14px",
          fontFamily: "monospace",
          fontSize: "0.8rem",
          color: isOpen ? color : "#9988cc",
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: isOpen ? `${color}08` : "transparent",
        }}
      >
        <span>start</span>
        <span style={{ fontSize: "0.6rem", opacity: 0.6 }}>{isOpen ? "▲" : "▼"}</span>
      </div>

      {isOpen && (
        <div style={{ padding: "0 14px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontFamily: "monospace", fontSize: "0.6rem", color: "#44446a" }}>
            Short HL (SL=borne haute, TP=borne basse) + pool 50/50 centré sur avgPx
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {[
              { label: "Marge HL (USDC)", val: hlAmount,   set: setHlAmount   },
              { label: "Pool (USDC)",     val: poolAmount, set: setPoolAmount  },
              { label: "Levier",          val: leverage,   set: setLeverage    },
            ].map(({ label, val, set }) => (
              <div key={label}>
                <div style={{ fontFamily: "monospace", fontSize: "0.58rem", color: "#6666aa", marginBottom: 3 }}>{label}</div>
                <input
                  type="number"
                  value={val}
                  onChange={e => { set(e.target.value); setConfirming(false); setStatus(null); setLog([]); }}
                  disabled={isLoading}
                  style={{
                    width: "100%", boxSizing: "border-box",
                    fontFamily: "monospace", fontSize: "0.8rem",
                    padding: "6px 8px", borderRadius: 5,
                    background: `${color}08`, border: `1px solid ${color}22`,
                    color: "#eaf6ff", outline: "none",
                    opacity: isLoading ? 0.5 : 1,
                  }}
                />
              </div>
            ))}
          </div>

          <button
            onClick={handleValidate}
            disabled={isLoading || !hlAmount || !poolAmount}
            style={{
              padding: "8px 14px",
              background: confirming ? "rgba(240,180,41,0.15)" : `${color}15`,
              border: `1px solid ${btnColor}66`,
              borderRadius: 5,
              color: (isLoading || !hlAmount || !poolAmount) ? `${btnColor}44` : btnColor,
              fontFamily: "monospace", fontSize: "0.75rem", fontWeight: 700,
              cursor: (isLoading || !hlAmount || !poolAmount) ? "default" : "pointer",
              transition: "all 0.15s",
            }}
          >
            {btnLabel}
          </button>

          {log.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {log.map((line, i) => (
                <div key={i} style={{
                  fontFamily: "monospace", fontSize: "0.68rem",
                  color: line.startsWith("⚠") ? "#c97070" : line.endsWith("✓") ? "#00e5a0" : "#9988cc",
                }}>
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Pool2TotalItem({ isOpen, onToggle }) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const color = "#64b4ff";

  async function fetchData() {
    setLoading(true);
    setError(null);
    try {
      const [hlRes, posRes, readyRes] = await Promise.all([
        fetch("/api/hyperliquid-status"),
        fetch("/api/positions2"),
        fetch("/api/pool2-ready"),
      ]);
      const hl    = await hlRes.json();
      const pos   = await posRes.json();
      const ready = await readyRes.json();
      if (hl.error)  throw new Error(hl.error);
      if (pos.error) throw new Error(pos.error);
      const hlValue   = parseFloat(hl.accountValue   ?? 0);
      const usdcValue = parseFloat(pos.usdcWallet    ?? 0);
      const wethValue = parseFloat(pos.wethWalletUSD ?? 0);
      setData({ hlValue, usdcValue, wethValue, total: hlValue + usdcValue + wethValue, ready: ready.ready });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div
        onClick={onToggle}
        style={{
          padding: "11px 14px",
          fontFamily: "monospace",
          fontSize: "0.8rem",
          color: isOpen ? color : "#9988cc",
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: isOpen ? `${color}08` : "transparent",
        }}
      >
        <span>pool2-total</span>
        <span style={{ fontSize: "0.6rem", opacity: 0.6 }}>{isOpen ? "▲" : "▼"}</span>
      </div>

      {isOpen && (
        <div style={{ padding: "0 14px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontFamily: "monospace", fontSize: "0.6rem", color: "#44446a" }}>
            Hyperliquid + USDC wallet + WETH wallet (pool 2)
          </div>

          <button
            onClick={fetchData}
            disabled={loading}
            style={{
              padding: "7px 14px",
              background: `${color}15`,
              border: `1px solid ${color}44`,
              borderRadius: 5,
              color: loading ? `${color}44` : color,
              fontFamily: "monospace",
              fontSize: "0.75rem",
              fontWeight: 700,
              cursor: loading ? "default" : "pointer",
              alignSelf: "flex-start",
            }}
          >
            {loading ? "..." : "↺ Calculer"}
          </button>

          {error && (
            <div style={{ fontFamily: "monospace", fontSize: "0.72rem", color: "#c97070" }}>⚠ {error}</div>
          )}

          {data && !loading && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {[
                { label: "Hyperliquid", value: data.hlValue },
                { label: "USDC wallet", value: data.usdcValue },
                { label: "WETH wallet", value: data.wethValue },
              ].map(({ label, value }) => (
                <div key={label} style={{ display: "flex", justifyContent: "space-between", fontFamily: "monospace", fontSize: "0.72rem", color: "#9988cc" }}>
                  <span>{label}</span>
                  <span>${value.toFixed(2)}</span>
                </div>
              ))}
              <div style={{
                display: "flex", justifyContent: "space-between",
                fontFamily: "monospace", fontSize: "0.85rem", fontWeight: 700,
                color: "#eaf6ff",
                borderTop: `1px solid ${color}22`,
                paddingTop: 6, marginTop: 2,
              }}>
                <span>Total</span>
                <span style={{ color }}>${data.total.toFixed(2)}</span>
              </div>
              <div style={{
                fontFamily: "monospace", fontSize: "0.78rem", fontWeight: 700,
                color: data.ready ? "#00e5a0" : "#c97070",
                marginTop: 4,
              }}>
                ready: {data.ready ? "true" : "false"}
              </div>
              {(() => {
                const toHl   = data.total / 8;
                const toPool = data.total - toHl;
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 6, borderTop: `1px solid ${color}22`, paddingTop: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "monospace", fontSize: "0.72rem", color: "#9988cc" }}>
                      <span>to invest hyperliquid</span>
                      <span style={{ color: "#a477ff" }}>${toHl.toFixed(2)}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "monospace", fontSize: "0.72rem", color: "#9988cc" }}>
                      <span>to invest pool</span>
                      <span style={{ color: "#a477ff" }}>${toPool.toFixed(2)}</span>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HyperliquidShortSection() {
  const [sizeUsd,    setSizeUsd]    = useState("");
  const [leverage,   setLeverage]   = useState("4");
  const [status,     setStatus]     = useState(null);
  const [result,     setResult]     = useState(null);
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef(null);

  function handleClick() {
    if (status === "loading") return;
    if (!sizeUsd || parseFloat(sizeUsd) <= 0) return;
    if (!confirming) {
      setConfirming(true);
      timerRef.current = setTimeout(() => setConfirming(false), 3000);
    } else {
      clearTimeout(timerRef.current);
      setConfirming(false);
      submit();
    }
  }

  async function submit() {
    setStatus("loading");
    setResult(null);
    try {
      const res  = await fetch("/api/hyperliquid-short", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ sizeUsd: parseFloat(sizeUsd), leverage: parseFloat(leverage) || 4 }),
      });
      const json = await res.json();
      setStatus(json.ok ? "ok" : "error");
      setResult(json);
    } catch (e) {
      setStatus("error");
      setResult({ error: e.message });
    }
  }

  const color    = "#e05aff";
  const btnColor = confirming ? "#f0b429" : color;
  const btnLabel = status === "loading" ? "..." : confirming ? "⚠ CONFIRMER ?" : "▼ SHORT ETH";

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontFamily: "monospace", fontSize: "0.65rem", color: "#6666aa", letterSpacing: "1.5px", textTransform: "uppercase", marginBottom: 10 }}>
        Hyperliquid
      </div>

      <div style={{
        background: "rgba(18,18,45,0.95)",
        border: `1px solid ${color}33`,
        borderRadius: 10,
        overflow: "hidden",
      }}>
        <div style={{
          padding: "7px 14px",
          background: `${color}0d`,
          borderBottom: `1px solid ${color}22`,
          fontFamily: "monospace", fontSize: "0.65rem",
          letterSpacing: "1.5px", textTransform: "uppercase",
          color, fontWeight: 600,
        }}>
          SHORT ETH — ISOLATED
        </div>

        <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 2 }}>
              <div style={{ fontFamily: "monospace", fontSize: "0.6rem", color: "#6666aa", marginBottom: 4 }}>MARGE (USDC)</div>
              <input
                type="number"
                value={sizeUsd}
                onChange={e => setSizeUsd(e.target.value)}
                placeholder="ex: 125"
                style={{
                  width: "100%", boxSizing: "border-box",
                  fontFamily: "monospace", fontSize: "0.8rem",
                  padding: "7px 10px", borderRadius: 5,
                  background: `${color}0a`, border: `1px solid ${color}33`,
                  color: "#eaf6ff", outline: "none",
                }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "monospace", fontSize: "0.6rem", color: "#6666aa", marginBottom: 4 }}>LEVIER</div>
              <input
                type="number"
                value={leverage}
                onChange={e => setLeverage(e.target.value)}
                min="1" max="50" step="1"
                style={{
                  width: "100%", boxSizing: "border-box",
                  fontFamily: "monospace", fontSize: "0.8rem",
                  padding: "7px 10px", borderRadius: 5,
                  background: `${color}0a`, border: `1px solid ${color}33`,
                  color: "#eaf6ff", outline: "none",
                }}
              />
            </div>
          </div>

          <button
            onClick={handleClick}
            disabled={status === "loading" || !sizeUsd || parseFloat(sizeUsd) <= 0}
            style={{
              padding: "9px 16px",
              background: confirming ? "rgba(240,180,41,0.15)" : status === "loading" ? `${color}11` : `${color}22`,
              border: `1px solid ${btnColor}66`,
              borderRadius: 6,
              color: status === "loading" ? `${btnColor}66` : btnColor,
              fontFamily: "monospace", fontSize: "0.75rem", fontWeight: 700, letterSpacing: "1px",
              cursor: (status === "loading" || !sizeUsd) ? "default" : "pointer",
              transition: "all 0.15s",
            }}
          >
            {btnLabel}
          </button>

          {result && status === "ok" && (
            <div style={{
              fontFamily: "monospace", fontSize: "0.7rem", color: "#00e5a0",
              background: "rgba(0,229,160,0.05)", border: "1px solid rgba(0,229,160,0.2)",
              borderRadius: 6, padding: "8px 12px",
              display: "flex", flexDirection: "column", gap: 3,
            }}>
              <span>Entrée  : <b>${result.ethPrice?.toFixed(2)}</b></span>
              <span>SL +5%  : <b style={{ color: "#f0b429" }}>${result.slPrice?.toFixed(2)}</b>{result.slResult?.status === "ok" ? " ✓" : result.slResult ? " ✗" : ""}</span>
              <span>Taille  : {result.sizeEth?.toFixed(4)} ETH ({result.notionalUsd} USDC notionnel, marge {result.marginUsd} USDC)</span>
              <span>Levier  : ×{result.leverage} isolated</span>
            </div>
          )}
          {result && (
            <pre style={{
              fontFamily: "monospace", fontSize: "0.65rem",
              color: status === "ok" ? "#4488aa" : "#c97070",
              background: "rgba(0,0,0,0.3)",
              border: `1px solid ${status === "ok" ? "rgba(40,80,120,0.3)" : "rgba(180,100,100,0.2)"}`,
              borderRadius: 6, padding: "10px 12px", margin: 0,
              overflowX: "auto", maxHeight: 160, overflowY: "auto",
              whiteSpace: "pre-wrap", wordBreak: "break-word",
            }}>
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
