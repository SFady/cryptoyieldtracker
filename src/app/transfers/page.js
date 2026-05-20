"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../context/AuthContext";

export default function TransfersPage() {
  const { activeUser } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (activeUser !== "set3") router.replace("/home");
  }, [activeUser, router]);

  const [transfers, setTransfers] = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);

  useEffect(() => {
    fetch("/api/transfers")
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setTransfers(d.transfers ?? []); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const pool2 = transfers?.filter(t => t.poolNum === 2) ?? [];
  const pool3 = transfers?.filter(t => t.poolNum === 3) ?? [];

  const total2 = pool2.reduce((s, t) => s + parseFloat(t.amount), 0);
  const total3 = pool3.reduce((s, t) => s + parseFloat(t.amount), 0);

  return (
    <>
      {loading && (
        <div style={{ color: "#6666aa", fontFamily: "monospace", padding: "16px 0", display: "flex", alignItems: "center", gap: 10 }}>
          <span className="pulse-dot" />Chargement…
        </div>
      )}
      {error && (
        <div style={{ color: "#c97070", background: "rgba(180,100,100,0.08)", border: "1px solid rgba(180,100,100,0.3)", borderRadius: 8, padding: "12px 16px", fontFamily: "monospace", fontSize: "0.85rem", marginBottom: 12 }}>
          ⚠ {error}
        </div>
      )}

      {transfers && (
        <>
          <TransferTable label="Pool 2" rows={pool2} total={total2} />
          <TransferTable label="Pool 3" rows={pool3} total={total3} mt />
        </>
      )}
    </>
  );
}

function TransferTable({ label, rows, total, mt }) {
  return (
    <div style={{ marginTop: mt ? 28 : 0, marginBottom: 16 }}>
      <div className="section-header" style={mt ? { marginTop: 0 } : {}}>
        <span style={{
          fontSize: "0.95rem", fontWeight: 700, color: "#ffffff", fontFamily: "monospace",
          padding: "4px 12px", background: "rgba(124,77,255,0.12)",
          border: "1px solid rgba(124,77,255,0.3)", borderRadius: 6,
        }}>
          {label}
        </span>
        {rows.length > 0 && (
          <span className="perf-badge perf-badge--pos" style={{ marginLeft: "auto" }}>
            ${total.toFixed(2)}
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <p style={{ color: "#6666aa", fontFamily: "monospace", fontSize: "0.85rem" }}>Aucun envoi.</p>
      ) : (
        <div style={{ background: "rgba(20,26,36,0.95)", border: "1px solid rgba(124,77,255,0.15)", borderRadius: 12, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 90px 90px 1fr", padding: "6px 18px", background: "rgba(10,10,30,0.7)", borderBottom: "1px solid rgba(124,77,255,0.12)", fontSize: "0.6rem", fontFamily: "monospace", letterSpacing: "1.2px", textTransform: "uppercase", color: "#7766aa", fontWeight: 600 }}>
            <span>Date</span>
            <span>Source</span>
            <span style={{ textAlign: "right" }}>Montant</span>
            <span style={{ textAlign: "right" }}>Tx</span>
          </div>
          {rows.map((t, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 90px 90px 1fr", alignItems: "center", padding: "7px 18px", borderBottom: i < rows.length - 1 ? "1px solid rgba(124,77,255,0.06)" : "none", fontSize: "0.72rem", fontFamily: "monospace" }}>
              <span style={{ color: "#6666aa" }}>{t.date}</span>
              <span style={{ color: "#a78bfa", fontWeight: 700 }}>{t.source}</span>
              <span style={{ color: "#00e5a0", fontWeight: 700, textAlign: "right" }}>${t.amount}</span>
              <span style={{ textAlign: "right" }}>
                {t.txHash ? (
                  <a href={`https://basescan.org/tx/${t.txHash}`} target="_blank" rel="noreferrer" style={{ color: "#4488ff", fontSize: "0.65rem" }}>
                    {t.txHash.slice(0, 8)}…
                  </a>
                ) : (
                  <span style={{ color: "#333355" }}>—</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
