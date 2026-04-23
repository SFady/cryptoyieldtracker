"use client";

import { useEffect, useState, useCallback } from "react";

const REFRESH_INTERVAL = 5 * 60 * 1000;

const VOLATILITY_COLOR = {
  "Calme":        "#00e5a0",
  "Normal":       "#a477ff",
  "Agité":        "#f0b429",
  "Très volatile":"#c97070",
};

export default function AtrPanel() {
  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [lastFetch, setLastFetch] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const fetchAtr = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch("/api/atr");
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setData(json);
      setLastFetch(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAtr();
    const id = setInterval(fetchAtr, REFRESH_INTERVAL);
    return () => clearInterval(id);
  }, [fetchAtr]);

  const vColor = data ? (VOLATILITY_COLOR[data.volatility] ?? "#aaaacc") : "#aaaacc";

  return (
    <div style={{ maxWidth: 480 }}>

      {/* Prix + ATR */}
      <div style={{
        background: "rgba(10,10,30,0.7)",
        border: "1px solid rgba(124,77,255,0.25)",
        borderRadius: 12,
        padding: "16px 20px",
        marginBottom: 12,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}>
        <div>
          <div style={{ fontFamily: "monospace", fontSize: "0.65rem", color: "#6666aa", letterSpacing: "1.5px", marginBottom: 4 }}>
            WETH / USDC — BASE
          </div>
          <div style={{ fontFamily: "monospace", fontSize: "1.5rem", fontWeight: 700, color: "#eaf6ff" }}>
            {loading ? "—" : data ? `$${data.price.toLocaleString("en-US")}` : "—"}
          </div>
          {data && (
            <div style={{ fontFamily: "monospace", fontSize: "0.75rem", color: "#9988cc", marginTop: 4 }}>
              ATR({data.periods}) = <span style={{ color: "#eaf6ff" }}>${data.atr}</span>
              <span style={{ color: vColor, marginLeft: 10, fontWeight: 700 }}>
                {data.volatility}
              </span>
            </div>
          )}
        </div>
        <button
          onClick={fetchAtr}
          disabled={loading}
          style={{
            background: "rgba(124,77,255,0.15)",
            border: "1px solid rgba(124,77,255,0.3)",
            borderRadius: 6,
            color: loading ? "#555588" : "#a477ff",
            fontFamily: "monospace",
            fontSize: "0.7rem",
            padding: "6px 12px",
            cursor: loading ? "default" : "pointer",
            letterSpacing: "1px",
          }}
        >
          {loading ? "..." : "↺ REFRESH"}
        </button>
      </div>

      {error && (
        <div style={{
          color: "#c97070", background: "rgba(180,100,100,0.08)",
          border: "1px solid rgba(180,100,100,0.3)", borderRadius: 8,
          padding: "12px 16px", fontFamily: "monospace", fontSize: "0.85rem", marginBottom: 12,
        }}>
          ⚠ {error}
        </div>
      )}

      {data && (
        <>
          {/* Tableau volatilité */}
          <div style={{
            background: "rgba(18,18,45,0.95)",
            border: "1px solid rgba(124,77,255,0.2)",
            borderRadius: 12,
            overflow: "hidden",
            marginBottom: 12,
          }}>
            <div style={{
              display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
              padding: "8px 18px",
              background: "rgba(124,77,255,0.08)",
              borderBottom: "1px solid rgba(124,77,255,0.15)",
              fontFamily: "monospace", fontSize: "0.65rem", letterSpacing: "1.5px",
              textTransform: "uppercase", color: "#9988cc", fontWeight: 600,
            }}>
              <span>Volatilité</span>
              <span style={{ textAlign: "center" }}>ATR</span>
              <span style={{ textAlign: "right" }}>Range (×2)</span>
            </div>

            {[
              { label: "Calme",         atr: "$80",  range: "~7%"  },
              { label: "Normal",        atr: "$120", range: "~10%" },
              { label: "Agité",         atr: "$200", range: "~17%" },
              { label: "Très volatile", atr: "$300", range: "~26%" },
            ].map(({ label, atr, range }) => {
              const isCurrent = label === data.volatility;
              const color = VOLATILITY_COLOR[label];
              return (
                <div
                  key={label}
                  style={{
                    display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
                    padding: "11px 18px",
                    borderBottom: "1px solid rgba(255,255,255,0.03)",
                    background: isCurrent ? `${color}0f` : "transparent",
                    borderLeft: isCurrent ? `3px solid ${color}` : "3px solid transparent",
                  }}
                >
                  <span style={{ fontFamily: "monospace", fontSize: "0.85rem", fontWeight: isCurrent ? 700 : 400, color: isCurrent ? color : "#9988cc" }}>
                    {label}
                  </span>
                  <span style={{ fontFamily: "monospace", fontSize: "0.85rem", color: isCurrent ? "#eaf6ff" : "#6666aa", textAlign: "center" }}>
                    {isCurrent ? `$${data.atr}` : atr}
                  </span>
                  <span style={{ fontFamily: "monospace", fontSize: "0.85rem", fontWeight: isCurrent ? 700 : 400, color: isCurrent ? color : "#6666aa", textAlign: "right",
                    textShadow: isCurrent ? `0 0 10px ${color}66` : "none",
                  }}>
                    {isCurrent ? `${data.range2x}%` : range}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Bouton créer position */}
          <button
            onClick={() => setShowCreate(v => !v)}
            style={{
              width: "100%",
              padding: "13px",
              marginBottom: 12,
              background: showCreate ? "rgba(0,229,160,0.08)" : "rgba(0,229,160,0.12)",
              border: "1px solid rgba(0,229,160,0.35)",
              borderRadius: 10,
              color: "#00e5a0",
              fontFamily: "monospace",
              fontSize: "0.85rem",
              fontWeight: 700,
              letterSpacing: "1px",
              cursor: "pointer",
            }}
          >
            {showCreate ? "✕ ANNULER" : "+ CRÉER LA POSITION"}
          </button>

          {/* Panneau de création */}
          {showCreate && (
            <CreatePanel data={data} onClose={() => setShowCreate(false)} />
          )}

          <div style={{ fontFamily: "monospace", fontSize: "0.65rem", color: "#44446a", textAlign: "right" }}>
            {lastFetch ? lastFetch.toLocaleTimeString("fr-FR") : "—"} · {data.candleCount} bougies · {data.interval}
          </div>
        </>
      )}
    </div>
  );
}

function CreatePanel({ data, onClose }) {
  const [amount, setAmount]     = useState("");
  const [multiplier, setMultiplier] = useState("2.0");
  const [status, setStatus]     = useState(null); // null | "loading" | "ok" | "error"
  const [txMsg, setTxMsg]       = useState("");

  const half = (data.atrPct * parseFloat(multiplier)) / 2;
  const minPrice = (data.price * (1 - half / 100)).toFixed(2);
  const maxPrice = (data.price * (1 + half / 100)).toFixed(2);
  const rangePct = (data.atrPct * parseFloat(multiplier)).toFixed(2);

  async function handleCreate() {
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      setTxMsg("Montant invalide.");
      setStatus("error");
      return;
    }
    setStatus("loading");
    setTxMsg("");
    try {
      const res = await fetch("/api/createPosition", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountUSDC: parseFloat(amount),
          minPrice: parseFloat(minPrice),
          maxPrice: parseFloat(maxPrice),
          currentPrice: data.price,
        }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setStatus("ok");
      setTxMsg(json.message ?? "Position créée.");
    } catch (e) {
      setStatus("error");
      setTxMsg(e.message);
    }
  }

  const inputStyle = {
    width: "100%",
    background: "rgba(10,10,30,0.8)",
    border: "1px solid rgba(124,77,255,0.3)",
    borderRadius: 6,
    color: "#eaf6ff",
    fontFamily: "monospace",
    fontSize: "0.9rem",
    padding: "10px 14px",
    outline: "none",
    boxSizing: "border-box",
  };

  return (
    <div style={{
      background: "rgba(18,18,45,0.98)",
      border: "1px solid rgba(0,229,160,0.25)",
      borderRadius: 12,
      overflow: "hidden",
      marginBottom: 12,
    }}>
      <div style={{
        padding: "8px 18px",
        background: "rgba(0,229,160,0.06)",
        borderBottom: "1px solid rgba(0,229,160,0.15)",
        fontFamily: "monospace", fontSize: "0.65rem", letterSpacing: "1.5px",
        textTransform: "uppercase", color: "#00e5a0", fontWeight: 600,
      }}>
        Nouvelle position — WETH / USDC
      </div>

      <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Multiplicateur */}
        <div>
          <div style={{ fontFamily: "monospace", fontSize: "0.65rem", color: "#6666aa", letterSpacing: "1px", marginBottom: 6 }}>
            MULTIPLICATEUR ATR
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {["1.0", "2.0", "2.5"].map(m => (
              <button
                key={m}
                onClick={() => setMultiplier(m)}
                style={{
                  flex: 1,
                  padding: "7px",
                  background: multiplier === m ? "rgba(0,229,160,0.15)" : "rgba(124,77,255,0.08)",
                  border: `1px solid ${multiplier === m ? "rgba(0,229,160,0.4)" : "rgba(124,77,255,0.2)"}`,
                  borderRadius: 6,
                  color: multiplier === m ? "#00e5a0" : "#9988cc",
                  fontFamily: "monospace",
                  fontSize: "0.8rem",
                  fontWeight: multiplier === m ? 700 : 400,
                  cursor: "pointer",
                }}
              >
                ×{m}
              </button>
            ))}
          </div>
        </div>

        {/* Résumé range */}
        <div style={{
          background: "rgba(0,0,0,0.2)",
          border: "1px solid rgba(124,77,255,0.15)",
          borderRadius: 8,
          padding: "10px 14px",
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 4,
          textAlign: "center",
        }}>
          <div>
            <div style={{ fontFamily: "monospace", fontSize: "0.6rem", color: "#6666aa", marginBottom: 2 }}>MIN</div>
            <div style={{ fontFamily: "monospace", fontSize: "0.85rem", fontWeight: 700, color: "#c97070" }}>${Number(minPrice).toLocaleString("en-US")}</div>
          </div>
          <div>
            <div style={{ fontFamily: "monospace", fontSize: "0.6rem", color: "#6666aa", marginBottom: 2 }}>RANGE</div>
            <div style={{ fontFamily: "monospace", fontSize: "0.85rem", fontWeight: 700, color: "#eaf6ff" }}>{rangePct}%</div>
          </div>
          <div>
            <div style={{ fontFamily: "monospace", fontSize: "0.6rem", color: "#6666aa", marginBottom: 2 }}>MAX</div>
            <div style={{ fontFamily: "monospace", fontSize: "0.85rem", fontWeight: 700, color: "#00e5a0" }}>${Number(maxPrice).toLocaleString("en-US")}</div>
          </div>
        </div>

        {/* Montant USDC */}
        <div>
          <div style={{ fontFamily: "monospace", fontSize: "0.65rem", color: "#6666aa", letterSpacing: "1px", marginBottom: 6 }}>
            MONTANT (USDC)
          </div>
          <input
            type="number"
            placeholder="ex: 1000"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            style={inputStyle}
          />
        </div>

        {/* Feedback */}
        {txMsg && (
          <div style={{
            fontFamily: "monospace", fontSize: "0.8rem",
            color: status === "ok" ? "#00e5a0" : "#c97070",
            background: status === "ok" ? "rgba(0,229,160,0.07)" : "rgba(180,100,100,0.08)",
            border: `1px solid ${status === "ok" ? "rgba(0,229,160,0.25)" : "rgba(180,100,100,0.25)"}`,
            borderRadius: 6,
            padding: "10px 14px",
          }}>
            {status === "ok" ? "✓ " : "⚠ "}{txMsg}
          </div>
        )}

        {/* Confirmer */}
        <button
          onClick={handleCreate}
          disabled={status === "loading"}
          style={{
            padding: "12px",
            background: status === "loading" ? "rgba(0,229,160,0.05)" : "rgba(0,229,160,0.15)",
            border: "1px solid rgba(0,229,160,0.4)",
            borderRadius: 8,
            color: status === "loading" ? "#336655" : "#00e5a0",
            fontFamily: "monospace",
            fontSize: "0.85rem",
            fontWeight: 700,
            letterSpacing: "1px",
            cursor: status === "loading" ? "default" : "pointer",
          }}
        >
          {status === "loading" ? "ENVOI EN COURS..." : "CONFIRMER LA POSITION"}
        </button>
      </div>
    </div>
  );
}
