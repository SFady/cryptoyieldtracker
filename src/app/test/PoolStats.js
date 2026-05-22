"use client";

import React from "react";

function fmtVolume(n) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function Row({ label, value, accent, warn }) {
  return (
    <div>
      <div style={{ fontSize: "0.58rem", fontFamily: "monospace", letterSpacing: "1px", textTransform: "uppercase", color: "#445566", marginBottom: 2 }}>
        {label}
      </div>
      <div style={{
        fontSize: "0.78rem", fontFamily: "monospace", fontWeight: 700,
        color: warn ? "#e5a000" : accent ? "#a78bfa" : "#c4a6ff",
      }}>
        {value}
      </div>
    </div>
  );
}

export default function PoolStats() {
  const [data, setData]       = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError]     = React.useState(null);

  React.useEffect(() => {
    fetch("/api/poolStats")
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  return (
    <div style={{ marginBottom: 20, padding: "12px 16px", background: "rgba(20,26,36,0.8)", border: "1px solid rgba(124,77,255,0.15)", borderRadius: 10 }}>
      <div style={{ fontSize: "0.6rem", fontFamily: "monospace", letterSpacing: "1.5px", textTransform: "uppercase", color: "#7766aa", marginBottom: 10 }}>
        Staked vs Non-staké — Seuil de rentabilité
      </div>

      {loading && (
        <div style={{ fontSize: "0.72rem", fontFamily: "monospace", color: "#555577" }}>Chargement…</div>
      )}
      {error && (
        <div style={{ fontSize: "0.72rem", fontFamily: "monospace", color: "#c97070" }}>Erreur : {error}</div>
      )}

      {data && !data.error && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px 20px", marginBottom: 10 }}>
            <Row label="AERO / jour"      value={`${data.aeroPerDay.toLocaleString()} AERO`} />
            <Row label="Valeur / jour"    value={`$${data.aeroValuePerDay.toLocaleString()}`} />
            <Row label="Prix AERO"        value={`$${data.aeroPriceUsd}`} />
            <Row label="Fee tier"         value={`${data.feeRatePct}%`} />
            <Row label="Volume seuil/j"   value={fmtVolume(data.breakEvenDailyVolumeUsd)} accent />
            {data.epochExpired && (
              <Row label="Époque gauge"   value="expirée ⚠" warn />
            )}
          </div>
          <div style={{ fontSize: "0.63rem", fontFamily: "monospace", color: "#334455", lineHeight: 1.5 }}>
            Si volume réel pool &gt; {fmtVolume(data.breakEvenDailyVolumeUsd)} / jour → non-staké plus rentable<br />
            Vérifier le volume sur{" "}
            <span style={{ color: "#556677" }}>aerodrome.finance</span>
          </div>
        </>
      )}

      {data?.error && (
        <div style={{ fontSize: "0.72rem", fontFamily: "monospace", color: "#c97070" }}>Erreur : {data.error}</div>
      )}
    </div>
  );
}
