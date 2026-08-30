"use client";

import React from "react";

export default function PoolControls() {
  const [poolNum, setPoolNum]       = React.useState(3);
  const [confirming, setConfirming] = React.useState(null);
  const [running, setRunning]       = React.useState(null);
  const [result, setResult]         = React.useState(null);
  const [oldPosId, setOldPosId]     = React.useState('');
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
        if (poolNum === 2) {
          // Pool 2 : flux complet 20% range + short HL delta-neutre
          const res  = await fetch("/api/algo-start", { method: "POST" });
          const data = await res.json();
          if (data.ok)           setResult({ ok: true,  msg: `Ouvert ✓ — $${data.capital} USDC · range 20% · $${data.tickLowerPrice?.toFixed(0)}–$${data.tickUpperPrice?.toFixed(0)} · short ${data.ethAtOpen} ETH @ $${data.shortEntryPrice?.toFixed(0)}` });
          else if (data.skipped) setResult({ ok: null,  msg: `skipped — ${data.reason}` });
          else                   setResult({ ok: false, msg: data.error ?? JSON.stringify(data) });
        } else {
          const res  = await fetch("/api/autoRebalance", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ forceCase: 4, poolNum }),
          });
          const data = await res.json();
          if (data.ok)           setResult({ ok: true,  msg: `Position ouverte — range ${data.newRangePct}% · ETH $${data.livePrice?.toFixed(0)}` });
          else if (data.skipped) setResult({ ok: null,  msg: `skipped — ${data.reason}` });
          else                   setResult({ ok: false, msg: data.error ?? JSON.stringify(data) });
        }
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
      } else if (action === "rebalance") {
        const res  = await fetch(`/api/autoRebalance?case=10&poolNum=${poolNum}`);
        const data = await res.json();
        if (data.ok)           setResult({ ok: true,  msg: `Rebalance ✓ — range ${data.rangePct}% · $${data.minPrice}–$${data.maxPrice} · NFT #${data.createResult?.tokenId ?? "?"}${data.hlShort?.ok ? " · HL short ✓" : data.hlShort?.error ? " · HL short ✗" : ""}` });
        else if (data.skipped) setResult({ ok: null,  msg: `skipped — ${data.reason}` });
        else                   setResult({ ok: false, msg: data.error ?? JSON.stringify(data) });
      } else if (action === "patchL") {
        const res  = await fetch("/api/algo-patch-l", { method: "POST" });
        const data = await res.json();
        if (data.ok && !data.skipped) setResult({ ok: true,  msg: `L injecté ✓ — L=${data.liquidityL?.toFixed(1)} · P0=$${data.P0?.toFixed(0)} · ETH check=${data.ethCheck} (stocké: ${data.stored_shortSizeEth})` });
        else if (data.skipped)        setResult({ ok: null,  msg: `déjà présent — L=${data.liquidityL?.toFixed(1)}` });
        else                          setResult({ ok: false, msg: data.error ?? JSON.stringify(data) });
      } else if (action === "claimAero") {
        const res  = await fetch("/api/claim-aero-quick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ poolNum }),
        });
        const data = await res.json();
        if (!res.ok) { setResult({ ok: false, msg: data.error ?? JSON.stringify(data) }); return; }
        setResult({ ok: true, msg: `AERO réclamé ✓ — tokenId ${data.tokenId} · wallet AERO: ${data.aeroWallet}` });
      } else if (action === "closeOld") {
        const body = { poolNum: 2, noTransfer: true, keepWeth: true, skipActiveToken: true };
        const tid  = oldPosId.trim();
        if (tid) body.targetTokenIds = [parseInt(tid)];
        const res  = await fetch("/api/closePositions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        let data;
        try { data = await res.json(); } catch (_) { data = {}; }
        if (!res.ok) { setResult({ ok: false, msg: data.error ?? `Erreur serveur ${res.status}` }); return; }
        const n = data.collected?.length ?? 0;
        setResult({ ok: true, msg: `${n} vieille(s) fermée(s) · USDC: $${data.finalUsdc}${tid ? ` · ID ${tid}` : ''}` });
      } else if (action === "closeLpQuick") {
        const res  = await fetch("/api/close-lp-quick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ poolNum }),
        });
        const data = await res.json();
        if (!res.ok) { setResult({ ok: false, msg: data.error ?? JSON.stringify(data) }); return; }
        setResult({ ok: true, msg: `LP fermée ✓ — ${data.collected?.length ?? 0} position(s) · USDC: $${data.finalUsdc} · WETH: ${data.finalWeth}` });
      } else {
        const res  = await fetch("/api/closePositions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ poolNum, noTransfer: true, keepWeth: true }),
        });
        const data = await res.json();
        if (!res.ok) { setResult({ ok: false, msg: data.error ?? JSON.stringify(data) }); return; }

        // Fermer aussi les positions Hyperliquid (pool 2 uniquement)
        if (poolNum === 2) {
          try {
            const hlRes  = await fetch("/api/hyperliquid-cancel-all", { method: "POST" });
            const hlData = await hlRes.json();
            if (!hlRes.ok) throw new Error(hlData?.error ?? JSON.stringify(hlData));
            setResult({ ok: true, msg: `Fermé ✓ — ${data.collected?.length ?? 0} position(s) · Hyperliquid fermé` });
          } catch (hlErr) {
            setResult({ ok: true, msg: `LP fermée ✓ — Hyperliquid : ${hlErr.message}` });
          }
        } else {
          setResult({ ok: true, msg: `Fermé ✓ — ${data.collected?.length ?? 0} position(s)` });
        }
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
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={() => handleClick("open")} disabled={!!running} style={btnStyle("open", "0,229,160")}>
          {running === "open" ? "En cours…" : confirming === "open" ? "⚠ CONFIRMER ?" : "Ouvrir position"}
        </button>
        <button onClick={() => handleClick("collect")} disabled={!!running} style={btnStyle("collect", "100,180,255")}>
          {running === "collect" ? "En cours…" : confirming === "collect" ? "⚠ CONFIRMER ?" : "Collect manuel"}
        </button>
        <button onClick={() => handleClick("close")} disabled={!!running} style={btnStyle("close", "201,112,112")}>
          {running === "close" ? "En cours…" : confirming === "close" ? "⚠ CONFIRMER ?" : "Tout fermer"}
        </button>
        {poolNum === 2 && (
          <button onClick={() => handleClick("rebalance")} disabled={!!running} style={btnStyle("rebalance", "167,139,250")}>
            {running === "rebalance" ? "En cours… (3–5 min)" : confirming === "rebalance" ? "⚠ CONFIRMER ?" : "↺ Rebalance"}
          </button>
        )}
        {poolNum === 2 && (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="text"
              value={oldPosId}
              onChange={e => setOldPosId(e.target.value)}
              placeholder="ID (vide = toutes)"
              style={{
                fontFamily: "monospace", fontSize: "0.72rem",
                padding: "4px 8px", borderRadius: 5,
                background: "rgba(20,26,36,0.9)",
                border: "1px solid rgba(255,100,80,0.25)",
                color: "#ccaaaa", width: 140, outline: "none",
              }}
            />
            <button onClick={() => handleClick("closeOld")} disabled={!!running} style={btnStyle("closeOld", "255,100,80")}>
              {running === "closeOld" ? "En cours…" : confirming === "closeOld" ? "⚠ CONFIRMER ?" : "Fermer vieilles"}
            </button>
          </div>
        )}
        {poolNum === 2 && (
          <button onClick={() => handleClick("claimAero")} disabled={!!running} style={btnStyle("claimAero", "255,140,200")}>
            {running === "claimAero" ? "En cours…" : confirming === "claimAero" ? "⚠ CONFIRMER ?" : "Claim AERO"}
          </button>
        )}
        {poolNum === 2 && (
          <button onClick={() => handleClick("closeLpQuick")} disabled={!!running} style={btnStyle("closeLpQuick", "255,160,60")}>
            {running === "closeLpQuick" ? "En cours… (~30s)" : confirming === "closeLpQuick" ? "⚠ CONFIRMER ?" : "Fermer LP"}
          </button>
        )}
        {poolNum === 2 && (
          <button onClick={() => { if (!running) fire("patchL"); }} disabled={!!running} style={btnStyle("patchL", "255,200,80")}>
            {running === "patchL" ? "En cours…" : "Patch L"}
          </button>
        )}
      </div>
      <div style={{ marginTop: 6, fontSize: "0.58rem", fontFamily: "monospace", color: "#555577", letterSpacing: "0.5px" }}>
        cas 5 = collect auto 7h–8h · cas 6 = collect manuel
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
