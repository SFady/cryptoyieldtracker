"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../context/AuthContext";

const PAGE_SIZE = 15;

const REASON_LABELS = {
  oor_close_low:            "Sortie basse",
  oor_close_high:           "Sortie haute",
  range_shrink_rebalance:   "Resserrement",
  range_expand_rebalance:   "Élargissement",
  range_cap_shrink:         "Resserrement (plafond 20%)",
  range_rebalance_stale6h:  "Stale 6h",
  trend_shift_rebalance:    "Changement de tendance",
};

export default function ResultsPage() {
  const { activeUser } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (activeUser !== "set3") router.replace("/home");
  }, [activeUser, router]);

  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [page, setPage]       = useState(1);

  useEffect(() => {
    fetch("/api/results")
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setResults(d.results ?? []); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const poolRows = results ?? [];
  const closedRows = poolRows.filter(r => r.delta !== null);
  const totalDelta  = closedRows.reduce((s, r) => s + r.delta, 0);
  const pages    = Math.max(1, Math.ceil(poolRows.length / PAGE_SIZE));
  const pageRows = poolRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <>
      {loading && (
        <div style={{ color: "#6666aa", fontFamily: "monospace", padding: "16px 0", display: "flex", alignItems: "center", gap: 10 }}>
          <span className="pulse-dot" />Chargement…
        </div>
      )}
      {error && <div style={{ color: "#ff6b6b", fontFamily: "monospace", padding: "16px 0" }}>{error}</div>}

      {!loading && !error && (
        <>
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            fontFamily: "monospace", fontSize: "0.85rem", color: "#8888aa",
            padding: "10px 14px", marginBottom: 14, borderRadius: 8,
            background: "rgba(124,77,255,0.06)", border: "1px solid rgba(124,77,255,0.15)",
          }}>
            <span>{closedRows.length} cycle{closedRows.length > 1 ? "s" : ""} clôturé{closedRows.length > 1 ? "s" : ""}</span>
            <span style={{ fontWeight: 700, color: totalDelta >= 0 ? "#00e5a0" : "#ff6b6b" }}>
              Total : {totalDelta >= 0 ? "+" : ""}{totalDelta.toFixed(2)} $
            </span>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table className="results-table" style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace", fontSize: "0.8rem" }}>
              <thead>
                <tr style={{ color: "#6666aa", textAlign: "left", borderBottom: "1px solid rgba(124,77,255,0.15)" }}>
                  <th style={{ padding: "8px 10px" }}>Ouverture</th>
                  <th style={{ padding: "8px 10px" }}>Fermeture</th>
                  <th style={{ padding: "8px 10px" }}>Tendance</th>
                  <th style={{ padding: "8px 10px" }}>Raison</th>
                  <th style={{ padding: "8px 10px" }}>Range</th>
                  <th style={{ padding: "8px 10px" }}>Avant</th>
                  <th style={{ padding: "8px 10px" }}>Après</th>
                  <th style={{ padding: "8px 10px" }}>Fees</th>
                  <th style={{ padding: "8px 10px" }}>Gain</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map(r => (
                  <tr key={r.id} style={{ borderBottom: "1px solid rgba(124,77,255,0.06)" }}>
                    <td style={{ padding: "8px 10px", color: "#aaaacc", whiteSpace: "nowrap" }}>{r.date}</td>
                    <td style={{ padding: "8px 10px", color: "#aaaacc", whiteSpace: "nowrap" }}>{r.closedDate ?? "—"}</td>
                    <td style={{ padding: "8px 10px", color: "#a78bfa", fontWeight: 700 }}>{r.openTrend ?? "—"}</td>
                    <td style={{ padding: "8px 10px", color: "#8888aa" }}>{REASON_LABELS[r.closeReason] ?? (r.closeReason ?? "—")}</td>
                    <td style={{ padding: "8px 10px", color: "#a78bfa", whiteSpace: "nowrap" }}>
                      {r.rangeMin !== null && r.rangeMax !== null
                        ? `$${r.rangeMin.toFixed(0)}-$${r.rangeMax.toFixed(0)}${r.rangePct !== null ? ` (${r.rangePct.toFixed(2)}%)` : ""}`
                        : "—"}
                    </td>
                    <td style={{ padding: "8px 10px", color: "#aaaacc" }}>{r.before !== null ? `$${r.before.toFixed(2)}` : "—"}</td>
                    <td style={{ padding: "8px 10px", color: "#aaaacc" }}>{r.after !== null ? `$${r.after.toFixed(2)}` : "—"}</td>
                    <td style={{ padding: "8px 10px", color: "#aaaacc" }}>{r.aeroUsdc !== null ? `$${r.aeroUsdc.toFixed(2)}` : "—"}</td>
                    <td style={{ padding: "8px 10px", fontWeight: 700, whiteSpace: "nowrap", color: r.delta === null ? "#6666aa" : r.delta >= 0 ? "#00e5a0" : "#ff6b6b" }}>
                      {r.delta === null ? "en cours" : `${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(2)} $`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pages > 1 && (
            <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 16 }}>
              {Array.from({ length: pages }, (_, i) => i + 1).map(p => (
                <button key={p} onClick={() => setPage(p)}
                  style={{
                    fontFamily: "monospace", fontSize: "0.75rem", padding: "4px 10px", borderRadius: 4, cursor: "pointer",
                    background: page === p ? "rgba(124,77,255,0.25)" : "transparent",
                    border: `1px solid ${page === p ? "rgba(124,77,255,0.6)" : "rgba(124,77,255,0.2)"}`,
                    color: page === p ? "#c4a6ff" : "#666699",
                  }}>
                  {p}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
