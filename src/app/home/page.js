"use client";

import React from "react";
import { useCryptoPrices } from "../components/useCryptoPrices";
import { getCryptos } from '../cryptos';
import { useAuth } from "../context/AuthContext";
import { useEffect, useState } from "react";

function formatPrice(price) {
  return price.toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function HomePage() {

  const { activeUser } = useAuth();

  // Set3 — valeurs stables pour la journée, venant du serveur
  const [dailyDelta, setDailyDelta] = useState(() => Array(15).fill(0));
  useEffect(() => {
    fetch("/api/dailyDelta")
      .then((r) => r.json())
      .then((d) => setDailyDelta(d.accumulated))
      .catch(() => {});
  }, []);

  const gainsFixes = [192, 220, 236, 210, 247, 12, 37, 190, 172, 225, 256, 227, 192, 325, -14];
  const totalGainsFixes = gainsFixes.reduce((acc, val) => acc + val, 0);
  const totalDailyDelta = dailyDelta.reduce((acc, val) => acc + val, 0);
  const moyenne = ((totalGainsFixes + totalDailyDelta) / gainsFixes.length).toFixed(2);

  const cryptos = getCryptos(activeUser);

  const { prices, error, tokenMap } = useCryptoPrices();

  if (activeUser !== "set3" && Object.keys(prices).length === 0) return <p>Loading...</p>;

  const totalGlobal = cryptos.reduce((sum, item) => {
    const price = prices[item.crypto];
    const total = price ? item.montant * price : 0;
    return sum + total;
  }, 0);

  const totalInvesti = cryptos.reduce((sum, item) => {
    const total = item.investi;
    return sum + total;
  }, 0);

  const rawPourcentage = ((totalGlobal - totalInvesti) / totalInvesti) * 100;
  const signe = rawPourcentage >= 0 ? "+ " : "- ";
  const pourcentage = Math.abs(rawPourcentage);

  const formattedPourcentage = `${signe}${pourcentage.toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

  if (activeUser === "set3") {
    return (
      <>
        {error && (
          <div style={{
            backgroundColor: '#ffdddd',
            color: '#a00',
            padding: '10px',
            marginBottom: '20px',
            borderRadius: '5px',
            border: '1px solid #a00',
            fontWeight: 'bold'
          }}>
            ⚠️ Erreur API : {error}
          </div>
        )}

        <div className="section-header">
          <h3 className="section-title">Portefeuille</h3>
          <div className="perf-badge perf-badge--pos">
            <span className="perf-badge__arrow">▲</span>
            <span className="perf-badge__value">+ {moyenne} %</span>
            <span className="perf-badge__label">P&L</span>
          </div>
        </div>
        <table className="table-large">
          <thead>
            <tr>
              <th>Bot</th>
              <th>Description</th>
              <th style={{ width: "140px" }}>Gain</th>
            </tr>
          </thead>
          <tbody>
            {[
              { label: "Grid 1",              desc: "C#",                                  status: "live" },
              { label: "Grid 2",              desc: "C#",                                  status: "live" },
              { label: "Grid 3",              desc: "Rust",                                status: "live" },
              { label: "Indicators 1",        desc: "C# (MACD, RSI, Bollinger, Fibonacci)",status: "live" },
              { label: "Indicators 2",        desc: "C# (Ichimoku, Keltner, ATR)",         status: "live" },
              { label: "Machine Learning 1",  desc: "Python, TensorFlow",                  status: "live" },
              { label: "Machine Learning 2",  desc: "Python, TensorFlow",                  status: "live" },
              { label: "Basic 1",             desc: "Java (RSI)",                          status: "live" },
              { label: "Basic 2",             desc: "Java (Fibonacci, pullback)",          status: "live" },
              { label: "Smart Rebalance",     desc: "Rust",                                status: "off"  },
              { label: "Grid Futures",        desc: "C#",                                  status: "live" },
              { label: "Custom trader algo 1",desc: "Java",                                status: "live" },
              { label: "Custom trader algo 2",desc: "Java",                                status: "live" },
              { label: "Martingale",          desc: "Rust",                                status: "live" },
              { label: "Custom trader algo 3",desc: "Java",                                status: "live" },
            ].map(({ label, desc, status }, i) => {
              const total = parseFloat((gainsFixes[i] + dailyDelta[i]).toFixed(2));
              const isPos = total >= 0;
              return (
                <tr key={i}>
                  <td>
                    {label}{" "}
                    <span style={{ color: status === "live" ? "green" : "grey" }}>
                      ({status === "live" ? "Live" : "Inactif"})
                    </span>
                  </td>
                  <td>{desc}</td>
                  <td style={{ color: isPos ? "green" : "red", fontFamily: "monospace" }}>
                    {isPos ? "+" : ""}{total} %
                    {dailyDelta[i] !== 0 && (
                      <span style={{
                        marginLeft: "8px",
                        fontSize: "0.72rem",
                        color: dailyDelta[i] > 0 ? "#00e5a0" : "#ff1744",
                        opacity: dailyDelta[i] < 0 ? 1 : 0.75,
                        fontWeight: dailyDelta[i] < 0 ? 700 : 400,
                      }}>
                        ({dailyDelta[i] > 0 ? "+" : "−"}{Math.abs(dailyDelta[i]).toFixed(2)}%)
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </>
    );
  }

  return (
    <>
      {error && (
        <div style={{
          backgroundColor: '#ffdddd',
          color: '#a00',
          padding: '10px',
          marginBottom: '20px',
          borderRadius: '5px',
          border: '1px solid #a00',
          fontWeight: 'bold'
        }}>
          ⚠️ Erreur API : {error}
        </div>
      )}

      <div className="section-header">
        <h3 className="section-title">Portefeuille</h3>
        <div className="portfolio-value">
          <span className="portfolio-value__amount">
            {totalGlobal.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $
          </span>
        </div>
        <div className={`perf-badge ${rawPourcentage >= 0 ? "perf-badge--pos" : "perf-badge--neg"}`}>
          <span className="perf-badge__arrow">{rawPourcentage >= 0 ? "▲" : "▼"}</span>
          <span className="perf-badge__value">{formattedPourcentage} %</span>
          <span className="perf-badge__label">P&L</span>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Crypto</th>
            <th style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>Investi ($)</th>
            <th style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>Valeur ($)</th>
          </tr>
        </thead>
        <tbody>
          {cryptos
            .map((item) => {
              const price = prices[item.crypto];
              const total = price ? item.montant * price : 0;
              const diff = total - item.investi;
              return { ...item, total, diff };
            })
            .sort((a, b) => b.diff - a.diff)
            .map((item, index) => (
              <tr key={index}>
                <td>{item.symbol}</td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {item.investi}
                </td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {item.total ? formatPrice(item.total) : "N/A"}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </>
  );
}
