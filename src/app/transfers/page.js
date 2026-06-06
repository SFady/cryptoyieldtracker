"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../context/AuthContext";

const PAGE_SIZE = 10;

export default function TransfersPage() {
  const { activeUser } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (activeUser !== "set3") router.replace("/home");
  }, [activeUser, router]);

  const [transfers, setTransfers]       = useState(null);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState(null);
  const [poolNum, setPoolNum]           = useState(2);
  const [page, setPage]                 = useState(1);
  const [wallet2Short, setWallet2Short] = useState("");
  const [wallet3Short, setWallet3Short] = useState("");

  useEffect(() => {
    fetch("/api/transfers")
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setTransfers(d.transfers ?? []); setWallet2Short(d.wallet2Short ?? ""); setWallet3Short(d.wallet3Short ?? ""); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { setPage(1); }, [poolNum]);

  const poolRows = transfers?.filter(t => t.poolNum === poolNum) ?? [];
  const total    = poolRows.reduce((s, t) => s + parseFloat(t.amount), 0);
  const pages    = Math.max(1, Math.ceil(poolRows.length / PAGE_SIZE));
  const pageRows = poolRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <>
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {[2, 3].map(n => (
          <button key={n} onClick={() => setPoolNum(n)}
            style={{
              fontFamily: "monospace", fontSize: "0.82rem", fontWeight: 700,
              padding: "7px 24px", borderRadius: 6, cursor: "pointer",
              background: poolNum === n ? "rgba(124,77,255,0.25)" : "transparent",
              border: `1px solid ${poolNum === n ? "rgba(124,77,255,0.6)" : "rgba(124,77,255,0.2)"}`,
              color: poolNum === n ? "#c4a6ff" : "#666699",
              transition: "all 0.15s",
            }}>
            Pool {n}
          </button>
        ))}
      </div>

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
        <TransferTable
          label={poolNum === 2 ? (wallet2Short || `Pool 2`) : (wallet3Short || `Pool 3`)}
          rows={pageRows}
          total={total}
          page={page}
          pages={pages}
          onPage={setPage}
        />
      )}
    </>
  );
}

function TransferTable({ label, rows, total, page, pages, onPage }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="section-header">
        <span style={{
          fontSize: "0.95rem", fontWeight: 700, color: "#ffffff", fontFamily: "monospace",
          padding: "4px 12px", background: "rgba(124,77,255,0.12)",
          border: "1px solid rgba(124,77,255,0.3)", borderRadius: 6,
        }}>
          {label}
        </span>
        {total > 0 && (
          <span className="perf-badge perf-badge--pos" style={{ marginLeft: "auto" }}>
            ${total.toFixed(2)}
          </span>
        )}
        {pages > 1 && (
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: 12 }}>
            <PaginBtn disabled={page <= 1} onClick={() => onPage(p => Math.max(1, p - 1))}>←</PaginBtn>
            <span style={{ fontFamily: "monospace", fontSize: "0.65rem", color: "#666699" }}>
              {page} / {pages}
            </span>
            <PaginBtn disabled={page >= pages} onClick={() => onPage(p => Math.min(pages, p + 1))}>→</PaginBtn>
          </div>
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

function PaginBtn({ disabled, onClick, children }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      fontFamily: "monospace", fontSize: "0.72rem", fontWeight: 700,
      padding: "3px 10px", borderRadius: 4,
      cursor: disabled ? "default" : "pointer",
      background: "transparent",
      border: `1px solid ${disabled ? "rgba(124,77,255,0.1)" : "rgba(124,77,255,0.3)"}`,
      color: disabled ? "#333355" : "#9988cc",
    }}>
      {children}
    </button>
  );
}
