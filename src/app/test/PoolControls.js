"use client";

import React from "react";

export default function PoolControls() {
  const [poolNum, setPoolNum]       = React.useState(3);
  const [confirming, setConfirming] = React.useState(null);
  const [running, setRunning]       = React.useState(null);
  const [result, setResult]         = React.useState(null);
  const timerRef = React.useRef(null);

  function handleClick(action) {
    if (running) return;
    if (confirming === action) {
      clearTimeout(timerRef.current);
      setConfirming(null);
      fire(action);
    } else {
      clearTimeout(timerRef.current);
      setConfirming(action);
      setResult(null);
      timerRef.current = setTimeout(() => setConfirming(null), 3000);
    }
  }

  async function fire(action) {
    setRunning(action);
    setResult(null);
    try {
      if (action === "open") {
        const res  = await fetch("/api/autoRebalance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ forceCase: 4, poolNum }),
        });
        const data = await res.json();
        if (data.ok)           setResult({ ok: true,  msg: `Position ouverte — range ${data.newRangePct}% · ETH $${data.livePrice?.toFixed(0)}` });
        else if (data.skipped) setResult({ ok: null,  msg: `skipped — ${data.reason}` });
        else                   setResult({ ok: false, msg: data.error ?? JSON.stringify(data) });
      } else if (action === "collect") {
        const res  = await fetch("/api/autoRebalance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ forceCase: 6, poolNum }),
        });
        const data = await res.json();
        if (data.ok)           setResult({ ok: true,  msg: `Fees collectées ✓` });
        else if (data.skipped) setResult({ ok: null,  msg: `skipped — ${data.reason}` });
        else                   setResult({ ok: false, msg: data.error ?? JSON.stringify(data) });
      } else {
        const res  = await fetch("/api/closePositions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ poolNum, noTransfer: true }),
        });
        const data = await res.json();
        if (res.ok) setResult({ ok: true,  msg: `Fermé ✓ — ${data.collected?.length ?? 0} position(s)` });
        else        setResult({ ok: false, msg: data.error ?? JSON.stringify(data) });
      }
    } catch (e) {
      setResult({ ok: false, msg: e.message });
    } finally {
      setRunning(null);
    }
  }

  const btnStyle = (action, color) => ({
    fontFamily: "monospace", fontSize: "0.78rem", fontWeight: 700,
    padding: "7px 18px", borderRadius: 6,
    cursor: running ? "not-allowed" : "pointer",
    transition: "all 0.15s",
    background: running === action ? "rgba(124,77,255,0.05)"
      : confirming === action ? `rgba(${color},0.15)`
      : `rgba(${color},0.12)`,
    border: `1px solid ${confirming === action ? `rgba(${color},0.7)` : `rgba(${color},0.35)`}`,
    color: running && running !== action ? "#444466"
      : confirming === action ? `rgb(${color})`
      : running === action ? "#666688"
      : `rgb(${color})`,
  });

  return (
    <div style={{ marginBottom: 20, padding: "12px 16px", background: "rgba(20,26,36,0.8)", border: "1px solid rgba(124,77,255,0.15)", borderRadius: 10 }}>
      <div style={{ fontSize: "0.6rem", fontFamily: "monospace", letterSpacing: "1.5px", textTransform: "uppercase", color: "#7766aa", marginBottom: 10 }}>
        Contrôles position
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        {[2, 3].map(n => (
          <button key={n} onClick={() => { setPoolNum(n); setResult(null); setConfirming(null); }}
            style={{
              fontFamily: "monospace", fontSize: "0.72rem", fontWeight: 700,
              padding: "4px 14px", borderRadius: 5, cursor: "pointer",
              background: poolNum === n ? "rgba(124,77,255,0.25)" : "transparent",
              border: `1px solid ${poolNum === n ? "rgba(124,77,255,0.6)" : "rgba(124,77,255,0.2)"}`,
              color: poolNum === n ? "#c4a6ff" : "#666699",
            }}>
            Pool {n}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => handleClick("open")} disabled={!!running} style={btnStyle("open", "0,229,160")}>
          {running === "open" ? "En cours…" : confirming === "open" ? "⚠ CONFIRMER ?" : "Ouvrir position"}
        </button>
        <button onClick={() => handleClick("collect")} disabled={!!running} style={btnStyle("collect", "100,180,255")}>
          {running === "collect" ? "En cours…" : confirming === "collect" ? "⚠ CONFIRMER ?" : "Collecter fees"}
        </button>
        <button onClick={() => handleClick("close")} disabled={!!running} style={btnStyle("close", "201,112,112")}>
          {running === "close" ? "En cours…" : confirming === "close" ? "⚠ CONFIRMER ?" : "Tout fermer"}
        </button>
      </div>
      {result && (
        <div style={{ marginTop: 8, fontSize: "0.72rem", fontFamily: "monospace",
          color: result.ok === true ? "#00e5a0" : result.ok === false ? "#c97070" : "#a78bfa" }}>
          {result.ok === true ? "✓" : result.ok === false ? "✗" : "—"} {result.msg}
        </div>
      )}
    </div>
  );
}
