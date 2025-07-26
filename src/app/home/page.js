"use client";

import React from "react";
import { useCryptoPrices } from "../components/useCryptoPrices";
import { cryptos } from '../cryptos';

function formatPrice(price) {
  if (price >= 1) {
    return price.toFixed(2);
  } else if (price >= 0.0001) {
    return price.toFixed(6);
  } else {
    return price.toExponential(2); // notation scientifique pour très petit prix
  }
}

export default function ProfilePage() {
  const { prices, error, tokenMap } = useCryptoPrices();

  if (Object.keys(prices).length === 0) return <p>Loading...</p>;

  const totalGlobal = cryptos.reduce((sum, item) => {
    const price = prices[item.crypto];
    const total = price ? item.montant * price : 0;
    return sum + total;
  }, 0);

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
        💰 Valeur totale du portefeuille :{" "}
        <strong>
          {totalGlobal.toLocaleString("fr-FR", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}{" "}
          $
        </strong>
      </h2>

      <br />
      <h3>Portefeuille</h3>
      <table>
        <thead>
          <tr>
            <th>Crypto</th>
            <th>Montant</th>
            <th>Prix ($)</th>
            <th>Valeur ($)</th>
          </tr>
        </thead>
        <tbody>
          {cryptos.map((item, index) => {
            const price = prices[item.crypto];
            const total = price ? item.montant * price : 0;
            return (
              <tr key={index}>
                <td>{item.symbol}</td>
                <td>{item.montant}</td>
                <td>{price ? formatPrice(price) : "N/A"}</td>
                <td>{price ? formatPrice(total) : "N/A"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
