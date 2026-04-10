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

function RobotIcon({ active = true, positive = true }) {
  const eyeColor = !active ? "#55557a" : positive ? "#00e5a0" : "#ff4d6d";
  const headFill = active ? "#1e1e4a" : "#252545";
  const headStroke = active ? "#7c4dff" : "#6060a0";
  const stripeFill = active ? "#2a2a60" : "#30305a";
  const grillFill = active ? "#4a4a80" : "#484878";
  const accentColor = active ? "#a477ff" : "#7070b0";
  return (
    <svg width="46" height="54" viewBox="0 0 62 72" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Antenna stem */}
      <rect x="29" y="1" width="4" height="11" rx="2" fill={headStroke}/>
      {/* Antenna tip */}
      <circle cx="31" cy="1.5" r="4" fill={accentColor}/>
      <circle cx="31" cy="1.5" r="2" fill={active ? "white" : "#555577"} opacity="0.6"/>
      {/* Ear connectors */}
      <rect x="0" y="22" width="5" height="13" rx="2.5" fill={headStroke} opacity="0.8"/>
      <rect x="57" y="22" width="5" height="13" rx="2.5" fill={headStroke} opacity="0.8"/>
      {/* Head body */}
      <rect x="5" y="12" width="52" height="42" rx="10" fill={headFill} stroke={headStroke} strokeWidth="2"/>
      {/* Header stripe */}
      <rect x="5" y="12" width="52" height="12" rx="10" fill={stripeFill}/>
      <rect x="5" y="20" width="52" height="4" fill={stripeFill}/>
      {/* Header dots */}
      <circle cx="14" cy="18" r="2.5" fill={accentColor}/>
      <circle cx="48" cy="18" r="2.5" fill={accentColor}/>
      <rect x="21" y="16" width="20" height="4" rx="2" fill={active ? "#3a3a70" : "#222240"}/>
      {/* Eye sockets */}
      <rect x="9" y="30" width="17" height="10" rx="5" fill="#0a0a1e"/>
      <rect x="36" y="30" width="17" height="10" rx="5" fill="#0a0a1e"/>
      {/* Eyes */}
      <rect x="10" y="31" width="15" height="8" rx="4" fill={eyeColor}/>
      <rect x="37" y="31" width="15" height="8" rx="4" fill={eyeColor}/>
      {/* Eye shine */}
      <rect x="12" y="32.5" width="6" height="3" rx="1.5" fill="white" opacity={active ? "0.35" : "0.08"}/>
      <rect x="39" y="32.5" width="6" height="3" rx="1.5" fill="white" opacity={active ? "0.35" : "0.08"}/>
      {/* Mouth grill bars */}
      <rect x="15" y="46" width="4" height="5" rx="2" fill={grillFill}/>
      <rect x="21" y="46" width="4" height="5" rx="2" fill={grillFill}/>
      <rect x="27" y="46" width="4" height="5" rx="2" fill={grillFill}/>
      <rect x="33" y="46" width="4" height="5" rx="2" fill={grillFill}/>
      <rect x="39" y="46" width="4" height="5" rx="2" fill={grillFill}/>
      {/* Neck */}
      <rect x="21" y="54" width="20" height="8" rx="4" fill={headFill} stroke={headStroke} strokeWidth="1.5"/>
      <rect x="26" y="57" width="10" height="2.5" rx="1.25" fill={grillFill}/>
      {/* Shoulders */}
      <rect x="9" y="62" width="44" height="9" rx="4.5" fill={headFill} stroke={headStroke} strokeWidth="1.5"/>
      <rect x="18" y="65" width="5" height="3" rx="1.5" fill={grillFill}/>
      <rect x="26" y="65" width="5" height="3" rx="1.5" fill={grillFill}/>
      <rect x="34" y="65" width="5" height="3" rx="1.5" fill={grillFill}/>
    </svg>
  );
}

export default function HomePage() {

  const { activeUser } = useAuth();
  //console.log(shouldShow);
  // useEffect(() => {
  // console.log("Auth status from context:", activeUser);
  // }, [activeUser]);

  // Set3
  const [gains, setGains] = useState(() => Array(15).fill(0));
  useEffect(() => {
    setGains(Array(15).fill(0).map(() => parseFloat((Math.random() * 1).toFixed(2))));
  }, []);

  const [gainsDynamic, setGainsDynamic] = useState(() => Array(15).fill(0));
  const [flashing, setFlashing] = useState(() => Array(15).fill(false));

  useEffect(() => {
    // Initialiser avec des valeurs random entre -0.05 et +0.05
    setGainsDynamic(Array(15).fill(0).map(() => parseFloat(((Math.random() * 0.1) - 0.05).toFixed(3))));
  }, []);

  useEffect(() => {
    const timers = [];

    function scheduleBot(i) {
      const delay = (Math.random() * 59 + 1) * 1000; // 1s à 1 minute
      const t = setTimeout(() => {
        const delta = parseFloat(((Math.random() * 0.1) - 0.05).toFixed(3));
        setGainsDynamic(prev => {
          const next = [...prev];
          next[i] = parseFloat((next[i] + delta).toFixed(3));
          return next;
        });
        setFlashing(prev => {
          const next = [...prev];
          next[i] = true;
          return next;
        });
        setTimeout(() => {
          setFlashing(prev => {
            const next = [...prev];
            next[i] = false;
            return next;
          });
        }, 600);
        scheduleBot(i); // replanifier ce bot
      }, delay);
      timers.push(t);
    }

    for (let i = 0; i < 15; i++) {
      if (i !== 9) scheduleBot(i); // exclure Smart Rebalance
    }

    return () => timers.forEach(clearTimeout);
  }, []);
  const totalGain = gains.reduce((acc, val) => acc + val, 0).toFixed(2);
  const totalGainNum = parseFloat(totalGain);
  const gainsFixes = [192, 220, 236, 210, 247, 12, 37, 190, 172, 225, 256, 227, 192, 325, -14];
  const totalGainsFixes = gainsFixes.reduce((acc, val) => acc + val, 0);
  const moyenne = ((totalGainsFixes + totalGainNum) / gainsFixes.length).toFixed(2);

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
        {/* Affichage de l'erreur en haut de page, si elle existe */}
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

        <h2>
          💰
          <strong style={{ color: "green" }}>
            &nbsp;&nbsp;&nbsp;+ {moyenne} %
          </strong>
        </h2>

        <br />
        <h3>Portefeuille</h3>
        <div className="table-with-icons">
          <table className="table-large" style={{ width: "auto", flexShrink: 0 }}>
            <thead>
              <tr>
                <th>Bot</th>
                <th>Description</th>
                <th style={{ width: "140px" }}>Gain</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Grid 1 <span style={{ color: "green" }}>(Live)</span></td>
                <td>C#</td>
                <td style={{ color: gainsFixes[0] >= 0 ? "green" : "red" }}>{gainsFixes[0] + gains[0]} %</td>
              </tr>
              <tr>
                <td>Grid 2 <span style={{ color: "green" }}>(Live)</span></td>
                <td>C#</td>
                <td style={{ color: gainsFixes[1] >= 0 ? "green" : "red" }}>{gainsFixes[1] + gains[1]} %</td>
              </tr>
              <tr>
                <td>Grid 3 <span style={{ color: "green" }}>(Live)</span></td>
                <td>Rust</td>
                <td style={{ color: gainsFixes[2] >= 0 ? "green" : "red" }}>{gainsFixes[2] + gains[2]} %</td>
              </tr>
              <tr>
                <td>Indicators 1 <span style={{ color: "green" }}>(Live)</span></td>
                <td>C# (MACD, RSI, Bollinger, Fibonacci)</td>
                <td style={{ color: gainsFixes[3] >= 0 ? "green" : "red" }}>{gainsFixes[3] + gains[3]} %</td>
              </tr>
              <tr>
                <td>Indicators 2 <span style={{ color: "green" }}>(Live)</span></td>
                <td>C# (Ichimoku ,keltner, ATR)</td>
                <td style={{ color: gainsFixes[4] >= 0 ? "green" : "red" }}>{gainsFixes[4] + gains[4]} %</td>
              </tr>
              <tr>
                <td>Machine Learning 1 <span style={{ color: "green" }}>(Live)</span></td>
                <td>Python, Tensor Flow</td>
                <td style={{ color: gainsFixes[5] >= 0 ? "green" : "red" }}>{gainsFixes[5] + gains[5]} %</td>
              </tr>
              <tr>
                <td>Machine Learning 2 <span style={{ color: "green" }}>(Live)</span></td>
                <td>Python, Tensor Flow</td>
                <td style={{ color: gainsFixes[6] >= 0 ? "green" : "red" }}>{gainsFixes[6] + gains[6]} %</td>
              </tr>
              <tr>
                <td>Basic 1 <span style={{ color: "green" }}>(Live)</span></td>
                <td>Java (RSI)</td>
                <td style={{ color: gainsFixes[7] >= 0 ? "green" : "red" }}>{gainsFixes[7] + gains[7]} %</td>
              </tr>
              <tr>
                <td>Basic 2 <span style={{ color: "green" }}>(Live)</span></td>
                <td>Java (Fibonacci, pullback)</td>
                <td style={{ color: gainsFixes[8] >= 0 ? "green" : "red" }}>{gainsFixes[8] + gains[8]} %</td>
              </tr>
              <tr>
                <td>Smart Rebalance <span style={{ color: "Grey" }}>(Inactif)</span></td>
                <td>Rust</td>
                <td style={{ color: gainsFixes[9] >= 0 ? "green" : "red" }}>{gainsFixes[9] + gains[9]} %</td>
              </tr>
              <tr>
                <td>Grid Futures <span style={{ color: "green" }}>(Live)</span></td>
                <td>C#</td>
                <td style={{ color: gainsFixes[10] >= 0 ? "green" : "red" }}>{gainsFixes[10] + gains[10]} %</td>
              </tr>
              <tr>
                <td>Custom trader algo 1 <span style={{ color: "green" }}>(Live)</span></td>
                <td>Java</td>
                <td style={{ color: gainsFixes[11] >= 0 ? "green" : "red" }}>{gainsFixes[11] + gains[11]} %</td>
              </tr>
              <tr>
                <td>Custom trader algo 2 <span style={{ color: "green" }}>(Live)</span></td>
                <td>Java</td>
                <td style={{ color: gainsFixes[12] >= 0 ? "green" : "red" }}>{gainsFixes[12] + gains[12]} %</td>
              </tr>
              <tr>
                <td>Martingale <span style={{ color: "green" }}>(Live)</span></td>
                <td>Rust</td>
                <td style={{ color: gainsFixes[13] >= 0 ? "green" : "red" }}>{gainsFixes[13] + gains[13]} %</td>
              </tr>
              <tr>
                <td>Custom trader algo 3 <span style={{ color: "green" }}>(Live)</span></td>
                <td>Java</td>
                <td style={{ color: gainsFixes[14] >= 0 ? "green" : "red" }}>{gainsFixes[14] + gains[14]} %</td>
              </tr>
            </tbody>
          </table>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px", alignSelf: "flex-start" }}>
            {[
              "Grid 1", "Grid 2", "Grid 3", "Indicators 1", "Indicators 2",
              "ML 1", "ML 2", "Basic 1", "Basic 2", "Rebalance",
              "Grid Futures", "Algo 1", "Algo 2", "Martingale", "Algo 3",
            ].map((name, i) => {
              const val = gainsDynamic[i];
              const isPos = val >= 0;
              const disabled = i === 9;
              return (
                <div key={i} className={flashing[i] ? "bot-flash" : ""} style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  padding: "14px 10px 12px",
                  borderRadius: "14px",
                  backgroundColor: disabled ? "rgba(25,25,55,0.75)" : "rgba(15,15,35,0.85)",
                  border: `1px solid ${disabled ? "rgba(100,100,160,0.35)" : "rgba(124,77,255,0.22)"}`,
                  gap: "7px",
                  minWidth: "90px",
                  opacity: 1,
                  backdropFilter: "blur(6px)",
                  position: "relative",
                  overflow: "hidden",
                  transition: "box-shadow 0.2s",
                }}>
                  {!disabled && (
                    <div style={{
                      position: "absolute",
                      top: 0, left: 0, right: 0,
                      height: "1px",
                      background: "linear-gradient(90deg, transparent, rgba(164,119,255,0.5), transparent)",
                    }}/>
                  )}
                  <RobotIcon active={!disabled} positive={isPos} />
                  <span style={{ fontSize: "0.72rem", textAlign: "center", color: disabled ? "#8888bb" : "#9999cc", fontWeight: "500", letterSpacing: "0.4px", textTransform: "uppercase" }}>{name}</span>
                  {disabled
                    ? <span style={{ fontSize: "0.68rem", color: "#7777aa", display: "flex", alignItems: "center", justifyContent: "center", gap: "4px", width: "100%" }}>
                        <span style={{ width: "5px", height: "5px", borderRadius: "50%", backgroundColor: "#555588", display: "inline-block" }}/>
                        Inactif
                      </span>
                    : <span style={{ fontSize: "0.82rem", fontWeight: "700", color: isPos ? "#00e5a0" : "#ff4d6d", letterSpacing: "0.5px", display: "flex", alignItems: "center", gap: "3px" }}>
                        <span style={{ fontSize: "0.65rem" }}>{isPos ? "▲" : "▼"}</span>
                        {Math.abs(val).toFixed(2)}%
                      </span>
                  }
                </div>
              );
            })}
          </div>
        </div>
      </>
    );
  }
  else {
    return (
      <>
        {/* Affichage de l'erreur en haut de page, si elle existe */}
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

        <h2>
          💰 {" "}
          <strong>
            {totalGlobal.toLocaleString("fr-FR", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}{" "}
            $
          </strong>
          <strong style={{ color: rawPourcentage >= 0 ? "green" : "red" }}>
            &nbsp;&nbsp;&nbsp;{formattedPourcentage} %
          </strong>
        </h2>

        <br />
        <h3>Portefeuille</h3>
        <table>
          <thead>
            <tr>
              <th>Crypto</th>
              <th style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>Investi ($)</th>
              {/* <th>Prix ($)</th> */}
              <th style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>Valeur ($)</th>
            </tr>
          </thead>
          <tbody>
            {cryptos
              .map((item) => {
                const price = prices[item.crypto];
                const total = price ? item.montant * price : 0;
                const diff = total - item.investi; // on calcule le gain/perte
                return { ...item, total, diff };
              })
              .sort((a, b) => b.diff - a.diff) // tri décroissant
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

}
