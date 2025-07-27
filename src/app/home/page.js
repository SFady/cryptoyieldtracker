"use client";

import React from "react";
import { useCryptoPrices } from "../components/useCryptoPrices";
import { cryptos } from '../cryptos';

// function formatPrice(price) {
//   if (price >= 1) {
//     return price.toFixed(2);
//   } else if (price >= 0.0001) {
//     return price.toFixed(6);
//   } else {
//     return price.toExponential(2); // notation scientifique pour très petit prix
//   }
// }
function formatPrice(price) {
  return price.toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function ProfilePage() {
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

  const pourcentage = ((totalGlobal - totalInvesti) / totalInvesti) * 100;
  const signe = pourcentage >= 0 ? "+ " : "- ";
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
        <strong style={{ color: pourcentage >= 0 ? "green" : "red" }}>
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
          {cryptos.map((item, index) => {
            const price = prices[item.crypto];
            const total = price ? item.montant * price : 0;
            return (
              <tr key={index}>
                <td>{item.symbol}</td>
                {/* <td>{item.montant}</td> */}
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{item.investi}</td>
                {/* <td>{price ? formatPrice(price) : "N/A"}</td> */}
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{price ? formatPrice(total) : "N/A"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
