"use client";

import React from "react";

export default function HyperliquidStatus() {
  const [data, setData]       = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError]     = React.useState(null);

  async function fetchData() {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch("/api/hyperliquid-status");
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setData(json);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ marginBottom: 20, padding: "12px 16px", background: "rgba(20,26,36,0.8)", border: "1px solid rgba(124,77,255,0.15)", borderRadius: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: "0.6rem", fontFamily: "monospace", letterSpacing: "1.5px", textTransform: "uppercase", color: "#7766aa" }}>
          Hyperliquid — Pool 2
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          style={{
            background: "rgba(124,77,255,0.1)",
            border: "1px solid rgba(124,77,255,0.25)",
            borderRadius: 4,
            color: loading ? "#555577" : "#a477ff",
            fontFamily: "monospace",
            fontSize: "0.6rem",
            padding: "3px 8px",
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "..." : "↺"}
        </button>
      </div>

      {error && (
        <div style={{ fontSize: "0.72rem", fontFamily: "monospace", color: "#c97070", marginTop: 8 }}>
          Erreur : {error}
        </div>
      )}

      {data && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: "0.58rem", fontFamily: "monospace", letterSpacing: "1px", textTransform: "uppercase", color: "#445566", marginBottom: 2 }}>
            Valeur totale compte
          </div>
          <div style={{ fontSize: "0.78rem", fontFamily: "monospace", fontWeight: 700, color: "#a78bfa" }}>
            ${data.accountValue.toFixed(2)}
          </div>
        </div>
      )}
    </div>
  );
}
