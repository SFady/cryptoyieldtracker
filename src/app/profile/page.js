"use client";

import { useEffect, useState } from "react";

const WALLET2_SHORT = "0xac38…2f6";

export default function ProfilePage() {
  const [pos, setPos]           = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);

  const [pos2, setPos2]         = useState(null);
  const [loading2, setLoading2] = useState(true);
  const [error2, setError2]     = useState(null);

  useEffect(() => {
    fetch("/api/positions")
      .then((r) => r.json())
      .then((d) => { if (d.error) throw new Error(d.error); setPos(d); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));

    setTimeout(() => {
      fetch("/api/positions2")
        .then((r) => r.json())
        .then((d) => { if (d.error) throw new Error(d.error); setPos2(d); })
        .catch((e) => setError2(e.message))
        .finally(() => setLoading2(false));
    }, 700);
  }, []);

  return (
    <>
      {/* ── Wallet 1 : position fixe #66576887 ── */}
      <div className="section-header">
        <h3 className="section-title">Pools de liquidité</h3>
        {pos && (
          <span style={{
            fontSize: "0.72rem", color: "#6666aa", fontFamily: "monospace",
            padding: "3px 8px", background: "rgba(124,77,255,0.08)",
            border: "1px solid rgba(124,77,255,0.2)", borderRadius: 5,
          }}>
            #{pos.tokenId} · {pos.chain}
          </span>
        )}
        {pos && (
          <span className="perf-badge perf-badge--pos" style={{ marginLeft: "auto" }}>
            ${pos.totalUSD}
          </span>
        )}
      </div>

      {loading && <Spinner label="Lecture du contrat…" />}
      {error   && <ErrorBox msg={error} />}
      {pos     && <PositionCard pos={pos} />}

      {/* ── Wallet 2 : 0xac38…2f6 ── */}
      <div className="section-header" style={{ marginTop: 28 }}>
        <h3 className="section-title">Pools de liquidité</h3>
        <span style={{
          fontSize: "0.72rem", color: "#6666aa", fontFamily: "monospace",
          padding: "3px 8px", background: "rgba(124,77,255,0.08)",
          border: "1px solid rgba(124,77,255,0.2)", borderRadius: 5,
        }}>
          {WALLET2_SHORT}
        </span>
        {pos2 && (
          <span className="perf-badge perf-badge--pos" style={{ marginLeft: "auto" }}>
            ${pos2.totalUSD}
          </span>
        )}
      </div>

      {loading2 && <Spinner label="Lecture du contrat…" />}
      {error2   && <ErrorBox msg={error2} />}
      {pos2     && <PositionCard pos={pos2} />}
    </>
  );
}

function Spinner({ label }) {
  return (
    <div style={{ color: "#6666aa", fontFamily: "monospace", padding: "16px 0", display: "flex", alignItems: "center", gap: 10 }}>
      <span className="pulse-dot" />{label}
    </div>
  );
}

function ErrorBox({ msg }) {
  return (
    <div style={{
      color: "#ff3366", background: "rgba(255,51,102,0.08)",
      border: "1px solid rgba(255,51,102,0.3)", borderRadius: 8,
      padding: "12px 16px", fontFamily: "monospace", fontSize: "0.85rem", marginBottom: 12,
    }}>
      ⚠ {msg}
    </div>
  );
}

// simple=true : pas de valeurs USD (wallet 2 sans prix)
function PositionCard({ pos, simple = false }) {
  return (
    <div style={{
      background: "rgba(20,26,36,0.95)",
      border: `1px solid ${pos.inRange ? "rgba(0,229,160,0.25)" : "rgba(255,51,102,0.25)"}`,
      borderRadius: 12,
      overflow: "hidden",
      marginBottom: 12,
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
        padding: "12px 18px",
        background: "rgba(10,10,30,0.7)",
        borderBottom: "1px solid rgba(124,77,255,0.12)",
      }}>
        <span style={{ fontWeight: 700, fontSize: "1rem" }}>{pos.pair}</span>
        <span style={{
          fontSize: "0.65rem", fontFamily: "monospace", fontWeight: 700,
          padding: "3px 8px", borderRadius: 4,
          background: "rgba(0,82,255,0.12)", border: "1px solid rgba(0,82,255,0.3)", color: "#4488ff",
        }}>
          Base
        </span>
        {pos.protocol && (
          <span style={{
            fontSize: "0.65rem", fontFamily: "monospace", fontWeight: 700,
            padding: "3px 8px", borderRadius: 4,
            background: "rgba(164,119,255,0.1)", border: "1px solid rgba(164,119,255,0.3)", color: "#a477ff",
          }}>
            {pos.protocol}
          </span>
        )}
        <span style={{
          marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6,
          fontSize: "0.65rem", fontFamily: "monospace", fontWeight: 700,
          padding: "3px 8px", borderRadius: 4,
          background: pos.inRange ? "rgba(0,229,160,0.1)" : "rgba(255,51,102,0.1)",
          border: `1px solid ${pos.inRange ? "rgba(0,229,160,0.3)" : "rgba(255,51,102,0.3)"}`,
          color: pos.inRange ? "#00e5a0" : "#ff3366",
        }}>
          {pos.inRange && <span className="pulse-dot pulse-dot--sm" style={{ background: "#00e5a0" }} />}
          {pos.inRange ? "IN RANGE" : "OUT OF RANGE"}
        </span>
      </div>

      {/* Pool amounts */}
      <Section label="En pool">
        {pos.pool.map((t) => <TokenRow key={t.symbol} token={t} accent="#eaf6ff" showUsd={!simple} />)}
        {!simple && <TotalRow label="Total pool" value={`$${pos.totalPoolUSD}`} />}
      </Section>

      {/* Fees */}
      <Section label="Frais non collectés">
        {pos.fees.map((t) => <TokenRow key={t.symbol} token={t} accent="#f0b429" showUsd={!simple} />)}
        {!simple && <TotalRow label="Total frais" value={`$${pos.totalFeesUSD}`} />}
      </Section>

      {/* Footer */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "10px 18px",
        background: "rgba(10,10,30,0.4)",
        borderTop: "1px solid rgba(124,77,255,0.1)",
        fontSize: "0.72rem", fontFamily: "monospace", color: "#6666aa",
      }}>
        <span>#{pos.tokenId}</span>
        {!simple && (
          <span style={{ fontWeight: 700, fontSize: "0.88rem", color: "#00e5a0" }}>
            Total : ${pos.totalUSD}
          </span>
        )}
        {pos.ethPrice && <span>ETH = ${pos.ethPrice}</span>}
      </div>
    </div>
  );
}

function Section({ label, children }) {
  return (
    <div style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
      <div style={{
        padding: "6px 18px",
        fontSize: "0.6rem", fontFamily: "monospace", letterSpacing: "1px",
        textTransform: "uppercase", color: "#555588",
        background: "rgba(124,77,255,0.05)",
      }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function TokenRow({ token, accent, showUsd }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: "9px 18px", borderBottom: "1px solid rgba(255,255,255,0.03)",
    }}>
      <span style={{ fontFamily: "monospace", fontWeight: 600, color: accent, fontSize: "0.88rem" }}>
        {token.symbol}
      </span>
      <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
        <span style={{ fontFamily: "monospace", fontSize: "0.85rem", color: "#8888bb" }}>
          {token.balance}
        </span>
        {showUsd && token.usd && (
          <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: "0.88rem", color: "#eaf6ff", minWidth: 70, textAlign: "right" }}>
            ${token.usd}
          </span>
        )}
      </div>
    </div>
  );
}

function TotalRow({ label, value }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: "8px 18px",
      fontSize: "0.75rem", fontFamily: "monospace", color: "#6666aa",
    }}>
      <span>{label}</span>
      <span style={{ fontWeight: 700, color: "#eaf6ff" }}>{value}</span>
    </div>
  );
}
