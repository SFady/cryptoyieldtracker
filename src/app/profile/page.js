"use client";

import { useEffect, useState } from "react";

const WALLET1_SHORT = "0xaf96…2499";
const WALLET2_SHORT = "0xac38…2f6";

export default function ProfilePage() {
  const [pos1, setPos1]           = useState(null);
  const [loading1, setLoading1]   = useState(true);
  const [error1, setError1]       = useState(null);

  const [pos2, setPos2]           = useState(null);
  const [loading2, setLoading2]   = useState(true);
  const [error2, setError2]       = useState(null);

  const [pos3, setPos3]           = useState(null);
  const [loading3, setLoading3]   = useState(true);
  const [error3, setError3]       = useState(null);

  useEffect(() => {
    fetch("/api/positions")
      .then((r) => r.json())
      .then((d) => { if (d.error) throw new Error(d.error); setPos1(d.positions ?? []); })
      .catch((e) => setError1(e.message))
      .finally(() => setLoading1(false));

    setTimeout(() => {
      fetch("/api/positions2")
        .then((r) => r.json())
        .then((d) => { if (d.error) throw new Error(d.error); setPos2(d.positions ?? []); })
        .catch((e) => setError2(e.message))
        .finally(() => setLoading2(false));
    }, 700);

    setTimeout(() => {
      fetch("/api/positions3")
        .then((r) => r.json())
        .then((d) => { if (d.error) throw new Error(d.error); setPos3(d.positions ?? []); })
        .catch((e) => setError3(e.message))
        .finally(() => setLoading3(false));
    }, 1400);
  }, []);

  return (
    <>
      {/* ── Wallet 1 : WETH/USDC ── */}
      <SectionHeader label="WETH / USDC" wallet={WALLET1_SHORT} positions={pos1} />
      {loading1 && <Spinner label="Lecture du contrat…" />}
      {error1   && <ErrorBox msg={error1} />}
      {pos1 && pos1.length === 0 && !loading1 && <Empty />}
      {pos1 && pos1.map((p) => <PositionCard key={p.tokenId} pos={p} />)}

      {/* ── Wallet 2 : WETH/USDC ── */}
      <SectionHeader label="WETH / USDC" wallet={WALLET2_SHORT} positions={pos2} mt />
      {loading2 && <Spinner label="Découverte des positions…" />}
      {error2   && <ErrorBox msg={error2} />}
      {pos2 && pos2.length === 0 && !loading2 && <Empty />}
      {pos2 && pos2.map((p) => <PositionCard key={p.tokenId} pos={p} />)}

      {/* ── Wallet 1 : USDC/cbBTC ── */}
      <SectionHeader label="USDC / cbBTC" wallet={WALLET1_SHORT} positions={pos3} mt />
      {loading3 && <Spinner label="Lecture du contrat…" />}
      {error3   && <ErrorBox msg={error3} />}
      {pos3 && pos3.length === 0 && !loading3 && <Empty />}
      {pos3 && pos3.map((p) => <PositionCard key={p.tokenId} pos={p} />)}
    </>
  );
}

// ── Composants ────────────────────────────────────────────────────────────────

function SectionHeader({ label, wallet, positions, mt }) {
  const total = positions && positions.length > 0
    ? positions.reduce((s, p) => s + parseFloat(p.totalUSD), 0).toFixed(2)
    : null;
  return (
    <div className="section-header" style={mt ? { marginTop: 28 } : {}}>
      <h3 className="section-title">Pools de liquidité</h3>
      <span style={{
        fontSize: "0.72rem", color: "#6666aa", fontFamily: "monospace",
        padding: "3px 8px", background: "rgba(124,77,255,0.08)",
        border: "1px solid rgba(124,77,255,0.2)", borderRadius: 5,
      }}>
        {label} · {wallet}
      </span>
      {total && (
        <span className="perf-badge perf-badge--pos" style={{ marginLeft: "auto" }}>
          ${total}
        </span>
      )}
    </div>
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

function Empty() {
  return (
    <p style={{ color: "#6666aa", fontFamily: "monospace", fontSize: "0.85rem" }}>
      Aucune position active.
    </p>
  );
}

function PositionCard({ pos }) {
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
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 18px",
        background: "rgba(10,10,30,0.7)",
        borderBottom: "1px solid rgba(124,77,255,0.12)",
      }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ fontWeight: 700, fontSize: "1rem" }}>{pos.pair}</span>
          <div style={{ display: "flex", gap: 6 }}>
            <span style={{
              fontSize: "0.65rem", fontFamily: "monospace", fontWeight: 700,
              padding: "2px 7px", borderRadius: 4,
              background: "rgba(0,82,255,0.12)", border: "1px solid rgba(0,82,255,0.3)", color: "#4488ff",
            }}>
              Base
            </span>
            {pos.protocol && (
              <span style={{
                fontSize: "0.65rem", fontFamily: "monospace", fontWeight: 700,
                padding: "2px 7px", borderRadius: 4,
                background: "rgba(164,119,255,0.1)", border: "1px solid rgba(164,119,255,0.3)", color: "#a477ff",
              }}>
                {pos.protocol}
              </span>
            )}
          </div>
        </div>
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 6,
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
        {pos.pool.map((t) => <TokenRow key={t.symbol} token={t} accent="#eaf6ff" />)}
        <TotalRow label="Total pool" value={`$${pos.totalPoolUSD}`} />
      </Section>

      {/* Fees */}
      <Section label="Frais non collectés">
        {pos.fees.map((t) => <TokenRow key={t.symbol} token={t} accent="#f0b429" />)}
        <TotalRow label="Total frais" value={`$${pos.totalFeesUSD}`} highlight />
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
        <span style={{ fontWeight: 700, fontSize: "0.88rem", color: "#00e5a0" }}>
          Total : ${pos.totalUSD}
        </span>
        {pos.ethPrice  && <span>ETH = ${pos.ethPrice}</span>}
        {pos.wethPrice && <span>ETH = ${pos.wethPrice}</span>}
        {pos.btcPrice  && <span>BTC = ${pos.btcPrice}</span>}
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

function TokenRow({ token, accent }) {
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
        {token.usd && (
          <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: "0.88rem", color: "#eaf6ff", minWidth: 70, textAlign: "right" }}>
            ${token.usd}
          </span>
        )}
      </div>
    </div>
  );
}

function TotalRow({ label, value, highlight }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: highlight ? "10px 18px" : "8px 18px",
      background: highlight ? "rgba(240,180,41,0.07)" : "transparent",
      borderTop: highlight ? "1px solid rgba(240,180,41,0.2)" : "none",
    }}>
      <span style={{
        fontSize: highlight ? "0.8rem" : "0.75rem",
        fontFamily: "monospace",
        color: highlight ? "#f0b429" : "#6666aa",
        fontWeight: highlight ? 700 : 400,
        letterSpacing: highlight ? "0.5px" : 0,
      }}>
        {label}
      </span>
      <span style={{
        fontWeight: 700,
        fontFamily: "monospace",
        fontSize: highlight ? "1rem" : "0.88rem",
        color: highlight ? "#f0b429" : "#eaf6ff",
        textShadow: highlight ? "0 0 12px rgba(240,180,41,0.5)" : "none",
      }}>
        {value}
      </span>
    </div>
  );
}
