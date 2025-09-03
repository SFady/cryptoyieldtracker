"use client";

import React from "react";
import { useCryptoPrices } from "../components/useCryptoPrices";
import { getCryptos  } from '../cryptos';
import { useAuth } from "../context/AuthContext";
import { useMemo } from "react";

import { useEffect } from "react";

function formatPrice(price) {
  return price.toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function HomePage() {
  
  const { activeUser } = useAuth();
  //console.log(shouldShow);
// useEffect(() => {
 // console.log("Auth status from context:", activeUser);
// }, [activeUser]);

// Set3
  const gains = useMemo(() => Array(15).fill(0).map(() => parseFloat((Math.random() * 1).toFixed(2))), []);
  const totalGain = gains.reduce((acc, val) => acc + val, 0).toFixed(2);
  const totalGainNum = parseFloat(totalGain);
  const gainsFixes = [192, 220, 236, 210, 247, 12, 37, 190, 172, 225, 256, 227, 192, 325, -14 ];
  const totalGainsFixes = gainsFixes.reduce((acc, val) => acc + val, 0);
  const moyenne = ((totalGainsFixes+totalGainNum) / gainsFixes.length).toFixed(2);

  const cryptos = getCryptos(activeUser);

  const { prices, error, tokenMap } = useCryptoPrices();

  if (Object.keys(prices).length === 0) return <p>Loading...</p>;

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

  
  if (activeUser==="set3")
  {
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
      <table>
        <thead>
          <tr>
            <th>Bot</th>
            <th>Description</th>
            <th style={{ width: "120px" }}>Gain</th>
          </tr>
        </thead>
        <tbody>
          <tr>
              <td>Grid 1 <span style={{ color: "green" }}>(Live)</span></td>
              <td>C#</td>
              <td style={{ color: gainsFixes[0] >= 0 ? "green" : "red" }}>{gainsFixes[0]+gains[0]} %</td>
          </tr>
          <tr>
              <td>Grid 2 <span style={{ color: "green" }}>(Live)</span></td>
              <td>C#</td>
              <td style={{ color: gainsFixes[1] >= 0 ? "green" : "red" }}>{gainsFixes[1]+gains[1]} %</td>
          </tr>
          <tr>
              <td>Grid 3 <span style={{ color: "green" }}>(Live)</span></td>
              <td>C#</td>
              <td style={{ color: gainsFixes[2] >= 0 ? "green" : "red" }}>{gainsFixes[2]+gains[2]} %</td>
          </tr>
          <tr>
              <td>Indicators 1 <span style={{ color: "green" }}>(Live)</span></td>
              <td>C# (MACD, RSI, Bollinger, Fibonacci)</td>
              <td style={{ color: gainsFixes[3] >= 0 ? "green" : "red" }}>{gainsFixes[3]+gains[3]} %</td>
          </tr>
          <tr>
              <td>Indicators 2 <span style={{ color: "green" }}>(Live)</span></td>
              <td>C# (Ichimoku ,keltner, ATR)</td>
              <td style={{ color: gainsFixes[4] >= 0 ? "green" : "red" }}>{gainsFixes[4]+gains[4]} %</td>
          </tr>
          <tr>
              <td>Machine Learning 1 <span style={{ color: "green" }}>(Live)</span></td>
              <td>Python, Tensor Flow</td>
              <td style={{ color: gainsFixes[5] >= 0 ? "green" : "red" }}>{gainsFixes[5]+gains[5]} %</td>
          </tr>
           <tr>
              <td>Machine Learning 2 <span style={{ color: "green" }}>(Live)</span></td>
              <td>Python, Tensor Flow</td>
              <td style={{ color: gainsFixes[6] >= 0 ? "green" : "red" }}>{gainsFixes[6]+gains[6]} %</td>
          </tr>
          <tr>
              <td>Basic 1 <span style={{ color: "green" }}>(Live)</span></td>
              <td>Java (RSI)</td>
              <td style={{ color: gainsFixes[7] >= 0 ? "green" : "red" }}>{gainsFixes[7]+gains[7]} %</td>
          </tr>
          <tr>
              <td>Basic 2 <span style={{ color: "green" }}>(Live)</span></td>
              <td>Java (Fibonacci, pullback)</td>
              <td style={{ color: gainsFixes[8] >= 0 ? "green" : "red" }}>{gainsFixes[8]+gains[8]} %</td>
          </tr>
          <tr>
              <td>Smart Rebalance <span style={{ color: "green" }}>(Live)</span></td>
              <td>C#</td>
              <td style={{ color: gainsFixes[9] >= 0 ? "green" : "red" }}>{gainsFixes[9]+gains[9]} %</td>
          </tr>
          <tr>
              <td>Grid Futures <span style={{ color: "green" }}>(Live)</span></td>
              <td>C#</td>
              <td style={{ color: gainsFixes[10] >= 0 ? "green" : "red" }}>{gainsFixes[10]+gains[10]} %</td>
          </tr>
          <tr>
              <td>Custom trader algo 1 <span style={{ color: "green" }}>(Live)</span></td>
              <td>Java</td>
              <td style={{ color: gainsFixes[11] >= 0 ? "green" : "red" }}>{gainsFixes[11]+gains[11]} %</td>
          </tr>
          <tr>
              <td>Custom trader algo 2 <span style={{ color: "green" }}>(Live)</span></td>
              <td>Java</td>
              <td style={{ color: gainsFixes[12] >= 0 ? "green" : "red" }}>{gainsFixes[12]+gains[12]} %</td>
          </tr>
          <tr>
              <td>Martingale <span style={{ color: "green" }}>(Live)</span></td>
              <td>C#</td>
              <td style={{ color: gainsFixes[13] >= 0 ? "green" : "red" }}>{gainsFixes[13]+gains[13]} %</td>
          </tr>
          <tr>
              <td>Custom trader algo 3 <span style={{ color: "green" }}>(Live)</span></td>
              <td>Java</td>
              <td style={{ color: gainsFixes[14] >= 0 ? "green" : "red" }}>{gainsFixes[14]+gains[14]} %</td>
          </tr>
          {/* {cryptos
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
            ))} */}
        </tbody>
      </table>
        </>
    );
  }
  else
  {
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
