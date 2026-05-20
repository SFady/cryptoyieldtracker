"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../context/AuthContext";

const WALLET1_SHORT = "0xaf96…2499";
const WALLET2_SHORT = "0xac38…2f6";
const WALLET3_SHORT = "Pool 3";

export default function ProfilePage() {
  const { activeUser } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (activeUser !== "set3") router.replace("/home");
  }, [activeUser, router]);

  const [pos1, setPos1]           = useState(null);
  const [loading1, setLoading1]   = useState(true);
  const [error1, setError1]       = useState(null);

  const [pos2, setPos2]           = useState(null);
  const [usdcWallet2, setUsdcWallet2] = useState(null);
  const [wethWallet2, setWethWallet2] = useState(null);
  const [wethWalletUSD2, setWethWalletUSD2] = useState(null);
  const [percentileRange2, setPercentileRange2] = useState(null);
  const [nextCronAt2, setNextCronAt2] = useState(null);
  const [loading2, setLoading2]   = useState(true);
  const [error2, setError2]       = useState(null);

  const [pos3, setPos3]           = useState(null);
  const [usdcWallet3, setUsdcWallet3] = useState(null);
  const [wethWallet3, setWethWallet3] = useState(null);
  const [wethWalletUSD3, setWethWalletUSD3] = useState(null);
  const [percentileRange3, setPercentileRange3] = useState(null);
  const [nextCronAt3, setNextCronAt3] = useState(null);
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
        .then((d) => { if (d.error) throw new Error(d.error); setPos2(d.positions ?? []); setUsdcWallet2(d.usdcWallet ?? null); setWethWallet2(d.wethWallet ?? null); setWethWalletUSD2(d.wethWalletUSD ?? null); setPercentileRange2(d.percentileRangePct ?? null); setNextCronAt2(d.nextCronAt ?? null); })
        .catch((e) => setError2(e.message))
        .finally(() => setLoading2(false));
    }, 700);

    setTimeout(() => {
      fetch("/api/positions3")
        .then((r) => r.json())
        .then((d) => { if (d.error) throw new Error(d.error); setPos3(d.positions ?? []); setUsdcWallet3(d.usdcWallet ?? null); setWethWallet3(d.wethWallet ?? null); setWethWalletUSD3(d.wethWalletUSD ?? null); setPercentileRange3(d.percentileRangePct ?? null); setNextCronAt3(d.nextCronAt ?? null); })
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
      {pos1 && pos1.map((p) => <PositionCard key={p.tokenId} pos={p} showFeePercent />)}

      {/* ── Wallet 2 : WETH/USDC ── */}
      {(() => {
        const total2 = pos2
          ? pos2.reduce((s, p) => {
              const wethFees   = parseFloat(p.fees?.find(t => t.symbol === "WETH")?.usd ?? "0");
              const stableFees = parseFloat(p.fees?.find(t => t.symbol !== "WETH")?.usd ?? "0");
              const aeroFees   = parseFloat(p.aeroRevenueUSD ?? "0");
              return s + parseFloat(p.totalPoolUSD ?? "0") + wethFees + stableFees + aeroFees;
            }, 0)
            + parseFloat(usdcWallet2 || 0)
            + parseFloat(wethWalletUSD2 || 0)
          : null;
        return (
          <>
            <SectionHeader label="WETH / USDC" wallet={WALLET2_SHORT} positions={pos2} totalOverride={total2} mt />
            <div style={{ padding: "4px 0 2px 0", marginBottom: 10, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              {percentileRange2 !== null && (
                <span style={{
                  fontSize: "0.65rem", fontFamily: "monospace",
                  padding: "2px 8px", borderRadius: 4,
                  background: "rgba(124,77,255,0.08)", border: "1px solid rgba(124,77,255,0.25)", color: "#a78bfa",
                }}>
                  Range percentile 24h : {percentileRange2}%
                </span>
              )}
              {nextCronAt2 && (
                <span style={{
                  fontSize: "0.65rem", fontFamily: "monospace",
                  padding: "2px 8px", borderRadius: 4,
                  background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.25)", color: "#86efac",
                }}>
                  Prochain cron : {new Date(nextCronAt2).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </div>
            {loading2 && <Spinner label="Découverte des positions…" />}
            {error2   && <ErrorBox msg={error2} />}
            {pos2 && pos2.length === 0 && !loading2 && <Empty />}
            {pos2 && pos2.map((p, i) => <PositionCard key={p.tokenId} pos={p} showFeePercent showCollect usdcWallet={i === 0 ? usdcWallet2 : null} wethWallet={i === 0 ? wethWallet2 : null} wethWalletUSD={i === 0 ? wethWalletUSD2 : null} greenTotal={total2} />)}
          </>
        );
      })()}

      {/* ── Wallet 3 : WETH/USDC ── */}
      {(() => {
        const total3 = pos3
          ? pos3.reduce((s, p) => {
              const wethFees   = parseFloat(p.fees?.find(t => t.symbol === "WETH")?.usd ?? "0");
              const stableFees = parseFloat(p.fees?.find(t => t.symbol !== "WETH")?.usd ?? "0");
              const aeroFees   = parseFloat(p.aeroRevenueUSD ?? "0");
              return s + parseFloat(p.totalPoolUSD ?? "0") + wethFees + stableFees + aeroFees;
            }, 0)
            + parseFloat(usdcWallet3 || 0)
            + parseFloat(wethWalletUSD3 || 0)
          : null;
        return (
          <>
            <SectionHeader label="WETH / USDC" wallet={WALLET3_SHORT} positions={pos3} totalOverride={total3} mt />
            <div style={{ padding: "4px 0 2px 0", marginBottom: 10, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              {percentileRange3 !== null && (
                <span style={{
                  fontSize: "0.65rem", fontFamily: "monospace",
                  padding: "2px 8px", borderRadius: 4,
                  background: "rgba(124,77,255,0.08)", border: "1px solid rgba(124,77,255,0.25)", color: "#a78bfa",
                }}>
                  Range percentile 24h : {percentileRange3}%
                </span>
              )}
              {nextCronAt3 && (
                <span style={{
                  fontSize: "0.65rem", fontFamily: "monospace",
                  padding: "2px 8px", borderRadius: 4,
                  background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.25)", color: "#86efac",
                }}>
                  Prochain cron : {new Date(nextCronAt3).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </div>
            {loading3 && <Spinner label="Découverte des positions…" />}
            {error3   && <ErrorBox msg={error3} />}
            {pos3 && pos3.length === 0 && !loading3 && <Empty />}
            {pos3 && pos3.map((p, i) => <PositionCard key={p.tokenId} pos={p} showFeePercent showCollect usdcWallet={i === 0 ? usdcWallet3 : null} wethWallet={i === 0 ? wethWallet3 : null} wethWalletUSD={i === 0 ? wethWalletUSD3 : null} greenTotal={total3} />)}
          </>
        );
      })()}

    </>
  );
}

// ── Composants ────────────────────────────────────────────────────────────────

function SectionHeader({ label, wallet, positions, mt, includeAero, extraUSD = 0, totalOverride = null }) {
  const total = totalOverride !== null
    ? totalOverride.toFixed(2)
    : positions && positions.length > 0
      ? (positions.reduce((s, p) => {
          const aero = includeAero ? parseFloat(p.aeroRevenueUSD ?? 0) : 0;
          return s + parseFloat(p.totalUSD) + aero;
        }, 0) + extraUSD).toFixed(2)
      : null;
  return (
    <div className="section-header" style={mt ? { marginTop: 28 } : {}}>
      <span style={{
        fontSize: "0.95rem", fontWeight: 700, color: "#ffffff", fontFamily: "monospace",
        padding: "4px 12px", background: "rgba(124,77,255,0.12)",
        border: "1px solid rgba(124,77,255,0.3)", borderRadius: 6,
      }}>
        {label}
      </span>
      <span style={{
        fontSize: "0.72rem", color: "#6666aa", fontFamily: "monospace",
        padding: "3px 8px", background: "rgba(124,77,255,0.06)",
        border: "1px solid rgba(124,77,255,0.15)", borderRadius: 5,
      }}>
        {wallet}
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
      color: "#c97070", background: "rgba(180,100,100,0.08)",
      border: "1px solid rgba(180,100,100,0.3)", borderRadius: 8,
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

function PositionCard({ pos, showFeePercent, showCollect, usdcWallet, wethWallet, wethWalletUSD, greenTotal }) {
  const aeroUSD      = pos.aeroRevenueUSD ? parseFloat(pos.aeroRevenueUSD) : 0;
  const wethFeesUSD   = parseFloat(pos.fees?.find(t => t.symbol === "WETH")?.usd ?? "0");
  const stableFeesUSD = parseFloat(pos.fees?.find(t => t.symbol !== "WETH")?.usd ?? "0");
  const totalRevUSD   = aeroUSD + wethFeesUSD + stableFeesUSD;

  const feePct      = showFeePercent && pos.openTimestamp
    ? (() => {
        if (totalRevUSD <= 0) return "0.00";
        const base = greenTotal || parseFloat(pos.totalPoolUSD) || pos.initialUSD || 1;
        const minutes = Math.max(1, (Date.now() - pos.openTimestamp) / 60_000);
        const hours = minutes / 60;
        return ((totalRevUSD / hours * 24 * 30) / base * 100).toFixed(2);
      })()
    : null;
  const [collecting, setCollecting] = React.useState(false);
  const [collectResult, setCollectResult] = React.useState(null);
  const [confirming, setConfirming] = React.useState(false);
  const confirmTimer = React.useRef(null);

  function handleCollectClick() {
    if (collecting) return;
    if (!confirming) {
      setConfirming(true);
      confirmTimer.current = setTimeout(() => setConfirming(false), 3000);
    } else {
      clearTimeout(confirmTimer.current);
      setConfirming(false);
      handleCollect();
    }
  }

  async function handleCollect() {
    setCollecting(true);
    setCollectResult(null);
    try {
      const res  = await fetch("/api/collectRewards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenId: pos.tokenId }),
      });
      const data = await res.json();
      if (data.error) setCollectResult({ ok: false, msg: data.error });
      else setCollectResult({ ok: true, msg: `Collecté ✓ — Solde USDC : $${data.finalUsdc}` });
    } catch (e) {
      setCollectResult({ ok: false, msg: e.message });
    } finally {
      setCollecting(false);
    }
  }
  return (
    <div style={{
      background: "rgba(20,26,36,0.95)",
      border: `1px solid ${pos.inRange ? "rgba(0,229,160,0.25)" : "rgba(180,100,100,0.25)"}`,
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
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <span style={{
            fontSize: "0.65rem", fontFamily: "monospace", fontWeight: 700,
            padding: "2px 7px", borderRadius: 4, whiteSpace: "nowrap",
            background: "rgba(0,82,255,0.12)", border: "1px solid rgba(0,82,255,0.3)", color: "#4488ff",
          }}>
            Base
          </span>
          {pos.protocol && (
            <span style={{
              fontSize: "0.65rem", fontFamily: "monospace", fontWeight: 700,
              padding: "2px 7px", borderRadius: 4, whiteSpace: "nowrap",
              background: "rgba(164,119,255,0.1)", border: "1px solid rgba(164,119,255,0.3)", color: "#a477ff",
            }}>
              {pos.protocol}
            </span>
          )}
          {pos.rangePct && (
            <span style={{
              fontSize: "0.65rem", fontFamily: "monospace", fontWeight: 700,
              padding: "2px 7px", borderRadius: 4,
              background: "rgba(0,229,160,0.08)", border: "1px solid rgba(0,229,160,0.25)", color: "#00e5a0",
            }}>
              {pos.rangePct}%
            </span>
          )}
        </div>
        {pos.rangeLow && (
          <RangeBar low={pos.rangeLow} high={pos.rangeHigh} current={pos.wethPrice ?? pos.ethPrice} inRange={pos.inRange} />
        )}
      </div>

      {/* Pool amounts */}
      <Section label="En pool">
        {pos.pool.map((t) => <TokenRow key={t.symbol} token={t} accent="#eaf6ff" />)}
        <TotalRow label="Total pool" value={`$${pos.totalPoolUSD}`} />
      </Section>

      {/* Solde non utilisé */}
      {(usdcWallet !== null || wethWallet !== null) && (
        <Section label="Solde non utilisé">
          {usdcWallet && parseFloat(usdcWallet) > 0 && (
            <TokenRow token={{ symbol: "USDC", balance: usdcWallet, usd: usdcWallet }} accent="#00e5a0" />
          )}
          {wethWallet !== null && (
            <TokenRow token={{ symbol: "WETH", balance: wethWallet ?? "0.000000", usd: wethWalletUSD ?? "0.00" }} accent="#627eea" />
          )}
        </Section>
      )}

      {/* Fees */}
      <Section label="Frais non collectés">
        {pos.fees.map((t) => <TokenRow key={t.symbol} token={t} accent="#f0b429" />)}
        {aeroUSD > 0.001 && (
          <TokenRow token={{ symbol: "AERO", balance: pos.aeroBalance ?? "", usd: aeroUSD.toFixed(2) }} accent="#e86c00" />
        )}
        <TotalRow label="Total revenus" value={`$${totalRevUSD.toFixed(2)}`} highlight percent={feePct} percentSuffix="%/mois" />
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
        {pos.openTimestamp && (() => {
          const totalMin = Math.floor((Date.now() - pos.openTimestamp) / 60_000);
          const h = Math.floor(totalMin / 60);
          const m = totalMin % 60;
          return <span>Ouvert depuis {h}h {String(m).padStart(2, "0")}min</span>;
        })()}
        {pos.ethPrice  && <span>ETH = ${pos.ethPrice}</span>}
        {pos.wethPrice && <span>ETH = ${pos.wethPrice}</span>}
        {pos.btcPrice  && <span>BTC = ${pos.btcPrice}</span>}
      </div>

      {/* Bouton collecter */}
      {showCollect && (
        <div style={{ padding: "10px 18px", borderTop: "1px solid rgba(124,77,255,0.1)", background: "rgba(10,10,30,0.4)" }}>
          <button
            onClick={handleCollectClick}
            disabled={collecting}
            style={{
              fontFamily: "monospace", fontSize: "0.78rem", fontWeight: 700,
              padding: "6px 16px", borderRadius: 6,
              cursor: collecting ? "not-allowed" : "pointer",
              background: collecting ? "rgba(124,77,255,0.05)" : confirming ? "rgba(240,180,41,0.15)" : "rgba(124,77,255,0.2)",
              border: `1px solid ${confirming ? "rgba(240,180,41,0.6)" : "rgba(124,77,255,0.4)"}`,
              color: collecting ? "#444466" : confirming ? "#f0b429" : "#c4a6ff",
              transition: "all 0.2s",
            }}
          >
            {collecting ? "En cours…" : confirming ? "⚠ CONFIRMER ?" : "Collecter fees + AERO → USDC"}
          </button>
          {collectResult && (
            <div style={{
              marginTop: 8, fontSize: "0.75rem", fontFamily: "monospace",
              color: collectResult.ok ? "#00e5a0" : "#c97070",
            }}>
              {collectResult.ok ? "✓" : "⚠"} {collectResult.msg}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ label, children }) {
  return (
    <div style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
      <div style={{
        padding: "7px 18px",
        fontSize: "0.7rem", fontFamily: "monospace", letterSpacing: "1.5px",
        textTransform: "uppercase", color: "#9988cc", fontWeight: 600,
        background: "rgba(124,77,255,0.08)",
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

function TotalRow({ label, value, highlight, percent, percentSuffix = "%" }) {
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
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {percent && (
          <span style={{
            fontSize: "0.7rem", fontFamily: "monospace", fontWeight: 700,
            padding: "2px 7px", borderRadius: 4,
            background: "rgba(240,180,41,0.12)", border: "1px solid rgba(240,180,41,0.3)",
            color: "#f0b429",
          }}>
            {percent}{percentSuffix}
          </span>
        )}
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
    </div>
  );
}

function RangeBar({ low, high, current, inRange }) {
  const lo  = parseFloat(low);
  const hi  = parseFloat(high);
  const cur = parseFloat(current);
  const pct = (cur - lo) / (hi - lo); // <0 = below, >1 = above
  // Track goes from 15% to 72% (right: 28%); dot uses same bounds
  const dotLeft = Math.max(15, Math.min(72, 15 + pct * 57));
  const color   = inRange ? "#00e5a0" : "#c97070";
  return (
    <div style={{ position: "relative", width: "100%", height: 34 }}>
      {/* Track — se termine à 72% pour laisser place au label IN/OUT */}
      <div style={{
        position: "absolute", left: "15%", right: "28%",
        top: "55%", transform: "translateY(-50%)",
        height: 2, borderRadius: 1,
        background: inRange ? "rgba(0,229,160,0.35)" : "rgba(180,100,100,0.3)",
      }} />
      {/* Low label */}
      <span style={{
        position: "absolute", left: "15%", bottom: 1,
        transform: "translateX(-50%)",
        fontSize: "0.55rem", fontFamily: "monospace", color: "#555599", whiteSpace: "nowrap",
      }}>${lo.toFixed(0)}</span>
      {/* High label */}
      <span style={{
        position: "absolute", left: "72%", bottom: 1,
        transform: "translateX(-50%)",
        fontSize: "0.55rem", fontFamily: "monospace", color: "#555599", whiteSpace: "nowrap",
      }}>${hi.toFixed(0)}</span>
      {/* Current price label */}
      <span style={{
        position: "absolute", left: `${dotLeft}%`, top: 0,
        transform: "translateX(-50%)",
        fontSize: "0.55rem", fontFamily: "monospace", fontWeight: 700,
        color, whiteSpace: "nowrap",
      }}>${cur.toFixed(0)}</span>
      {/* Dot */}
      <div style={{
        position: "absolute", left: `${dotLeft}%`, top: "55%",
        transform: "translate(-50%, -50%)",
        width: 7, height: 7, borderRadius: "50%",
        background: color, boxShadow: `0 0 5px ${color}`,
      }} />
      {/* IN / OUT label à droite de la barre */}
      <span style={{
        position: "absolute", right: 0, top: "50%", transform: "translateY(-50%)",
        fontSize: "0.5rem", fontFamily: "monospace", fontWeight: 700,
        color, whiteSpace: "nowrap", letterSpacing: "0.5px",
      }}>
        {inRange ? "● IN" : "● OUT"}
      </span>
    </div>
  );
}
