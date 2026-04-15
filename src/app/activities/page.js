"use client";

// ── Paramètre de source des mises à jour des bots ──────────────────────────
// "server" : les gains sont poussés par le serveur via SSE (/api/bots)
// "local"  : la simulation tourne entièrement dans le navigateur du client
const BOT_FLASH_SOURCE = "local"; // "server" | "local"
// ──────────────────────────────────────────────────────────────────────────

import React, { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";

function BotIcon({ active = true, positive = true }) {
  const accent = active ? (positive ? "#00e5a0" : "#ff3366") : "#444466";
  const base = active ? "#1a1a40" : "#16162e";
  const border = active ? (positive ? "rgba(0,229,160,0.5)" : "rgba(255,77,109,0.5)") : "rgba(80,80,140,0.4)";
  const glow = active ? (positive ? "rgba(0,229,160,0.18)" : "rgba(255,77,109,0.18)") : "transparent";

  return (
    <svg width="52" height="52" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Outer glow ring */}
      <circle cx="26" cy="26" r="25" fill={glow} stroke={border} strokeWidth="1" />

      {/* Inner hex base */}
      <polygon
        points="26,6 43,16 43,36 26,46 9,36 9,16"
        fill={base}
        stroke={border}
        strokeWidth="1.2"
      />

      {/* Circuit lines */}
      <line x1="26" y1="6" x2="26" y2="13" stroke={accent} strokeWidth="1" opacity="0.4" />
      <line x1="43" y1="16" x2="37" y2="20" stroke={accent} strokeWidth="1" opacity="0.4" />
      <line x1="43" y1="36" x2="37" y2="32" stroke={accent} strokeWidth="1" opacity="0.4" />
      <line x1="26" y1="46" x2="26" y2="39" stroke={accent} strokeWidth="1" opacity="0.4" />
      <line x1="9" y1="36" x2="15" y2="32" stroke={accent} strokeWidth="1" opacity="0.4" />
      <line x1="9" y1="16" x2="15" y2="20" stroke={accent} strokeWidth="1" opacity="0.4" />

      {/* Inner ring */}
      <circle cx="26" cy="26" r="11" fill="none" stroke={accent} strokeWidth="0.8" opacity="0.35" strokeDasharray="3 2" />

      {/* Center core */}
      <circle cx="26" cy="26" r="7" fill={active ? "rgba(26,26,64,0.9)" : "rgba(20,20,46,0.9)"} stroke={accent} strokeWidth="1.2" />

      {/* Center symbol: chart up / chart down / pause */}
      {active ? (
        positive ? (
          /* up arrow */
          <polyline points="21,30 26,21 31,30" fill="none" stroke={accent} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          /* down arrow */
          <polyline points="21,22 26,31 31,22" fill="none" stroke={accent} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        )
      ) : (
        /* pause bars */
        <>
          <rect x="23" y="22" width="2" height="8" rx="1" fill={accent} />
          <rect x="27" y="22" width="2" height="8" rx="1" fill={accent} />
        </>
      )}

      {/* Status dot — top right */}
      <circle cx="38" cy="14" r="3.5" fill={active ? (positive ? "#00e5a0" : "#ff3366") : "#333355"} stroke={base} strokeWidth="1" />

      {/* Corner circuit nodes */}
      <circle cx="26" cy="6" r="1.5" fill={accent} opacity="0.5" />
      <circle cx="26" cy="46" r="1.5" fill={accent} opacity="0.5" />
      <circle cx="9" cy="16" r="1.5" fill={accent} opacity="0.5" />
      <circle cx="43" cy="16" r="1.5" fill={accent} opacity="0.5" />
      <circle cx="9" cy="36" r="1.5" fill={accent} opacity="0.5" />
      <circle cx="43" cy="36" r="1.5" fill={accent} opacity="0.5" />
    </svg>
  );
}

const BOT_NAMES = [
  "Grid 1", "Grid 2", "Grid 3", "Indicators 1", "Indicators 2",
  "ML 1", "ML 2", "Basic 1", "Basic 2", "Rebalance",
  "Grid Futures", "Algo 1", "Algo 2", "Martingale", "Algo 3",
];

function triggerFlash(setFlashing, botIndex) {
  setFlashing(prev => {
    const next = [...prev];
    next[botIndex] = true;
    return next;
  });
  setTimeout(() => {
    setFlashing(prev => {
      const next = [...prev];
      next[botIndex] = false;
      return next;
    });
  }, 600);
}

export default function ActivitiesPage() {
  const { activeUser } = useAuth();

  const mode = BOT_FLASH_SOURCE;
  const [gainsDynamic, setGainsDynamic] = useState(() => Array(15).fill(0));
  const [flashing, setFlashing] = useState(() => Array(15).fill(false));
  const [connected, setConnected] = useState(false);

  const localGainsRef = useRef(Array(15).fill(0));
  const localTimers = useRef([]);

  // ── Mode serveur : SSE ────────────────────────────────────────────────────
  useEffect(() => {
    if (mode !== "server") return;

    setConnected(false);
    const es = new EventSource("/api/bots");

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      const data = JSON.parse(e.data);

      if (data.type === "init") {
        setGainsDynamic(data.gains);
        setConnected(true);
        return;
      }

      if (data.type === "update") {
        const { botIndex, gain } = data;
        setGainsDynamic(prev => {
          const next = [...prev];
          next[botIndex] = gain;
          return next;
        });
        triggerFlash(setFlashing, botIndex);
      }
    };

    es.onerror = () => setConnected(false);

    return () => es.close();
  }, [mode]);

  // ── Mode local : simulation client ────────────────────────────────────────
  useEffect(() => {
    if (mode !== "local") return;

    // Initialisation
    const initGains = Array(15)
      .fill(0)
      .map(() => parseFloat(((Math.random() * 0.1) - 0.05).toFixed(3)));
    localGainsRef.current = initGains;
    setGainsDynamic([...initGains]);
    setConnected(true);

    function scheduleBot(i) {
      const delay = (Math.random() * 59 + 1) * 1000;
      const id = setTimeout(() => {
        const delta = parseFloat(((Math.random() * 0.1) - 0.05).toFixed(3));
        localGainsRef.current[i] = parseFloat((localGainsRef.current[i] + delta).toFixed(3));
        const gain = localGainsRef.current[i];

        setGainsDynamic(prev => {
          const next = [...prev];
          next[i] = gain;
          return next;
        });
        triggerFlash(setFlashing, i);
        scheduleBot(i);
      }, delay);
      localTimers.current.push(id);
    }

    for (let i = 0; i < 15; i++) {
      if (i !== 9) scheduleBot(i);
    }

    return () => {
      localTimers.current.forEach(clearTimeout);
      localTimers.current = [];
      setConnected(false);
    };
  }, [mode]);

  if (activeUser !== "set3") {
    return <p>Accès non autorisé.</p>;
  }

  const activeBots = BOT_NAMES.filter((_, i) => i !== 9).length;

  return (
    <>
      <div className="bots-header">
        <div className="bots-header-stat">
          <span className="bots-header-label">BOTS ACTIFS</span>
          <span className="bots-header-value">{activeBots} / {BOT_NAMES.length}</span>
        </div>
        <div className="bots-header-stat">
          <span className="bots-header-label">STATUT</span>
          {connected
            ? <span className="bots-header-value bots-status-live">
              <span className="pulse-dot" />
              LIVE
            </span>
            : <span className="bots-header-value" style={{ color: "#ff3366" }}>
              <span className="pulse-dot" style={{ background: "#ff3366" }} />
              RECONNECTING
            </span>
          }
        </div>
        <div className="bots-header-stat">
          <span className="bots-header-label">SESSION P&L</span>
          <span className="bots-header-value" style={{ color: "#00e5a0" }}>
            +{gainsDynamic.filter((_, i) => i !== 9).reduce((a, b) => a + b, 0).toFixed(3)}%
          </span>
        </div>
      </div>

      <div className="bots-grid">
        {BOT_NAMES.map((name, i) => {
          const val = gainsDynamic[i];
          const isPos = val >= 0;
          const disabled = i === 9;
          const accent = disabled ? "#555588" : isPos ? "#00e5a0" : "#ff3366";

          return (
            <div
              key={i}
              className={`bot-card${flashing[i] ? (isPos ? " bot-flash" : " bot-flash--neg") : ""}${disabled ? " bot-card--offline" : ""}`}
            >
              <div className="bot-card__accent" style={{ backgroundColor: accent }} />

              <div className="bot-card__header">
                <span className="bot-card__name">{name}</span>
                {disabled
                  ? <span className="bot-badge bot-badge--off">OFF</span>
                  : <span className="bot-badge bot-badge--live">
                    <span className="pulse-dot pulse-dot--sm" />
                    LIVE
                  </span>
                }
              </div>

              <div className="bot-card__robot">
                <BotIcon active={!disabled} positive={isPos} />
              </div>

              {disabled
                ? <span className="bot-card__gain bot-card__gain--off">INACTIF</span>
                : <span className="bot-card__gain" style={{ color: accent }}>
                  {isPos ? "▲" : "▼"} {Math.abs(val).toFixed(3)}%
                </span>
              }
            </div>
          );
        })}
      </div>
    </>
  );
}
