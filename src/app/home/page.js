"use client";

import React from "react";
import { useCryptoPrices } from "../components/useCryptoPrices";
import { getCryptos  } from '../cryptos';
import { useAuth } from "../context/AuthContext";

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
//   console.log("Auth status from context:", activeUser);
// }, [activeUser]);

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
