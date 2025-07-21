"use client";

import React from "react";
import { useCryptoPrices } from "../components/useCryptoPrices"; // adjust path

export default function ProfilePage() {
  const { prices, error, tokenMap } = useCryptoPrices();

  if (error) return <p>{error}</p>;
  if (Object.keys(prices).length === 0) return <p>Loading...</p>;

  return (
    <>
    <br></br>
     <table>
        <thead>
          <tr>
            <th>Crypto</th>
            <th>Valeur</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(tokenMap).map(([id, symbol]) => (
            <tr key={id}>
              <td>{symbol}</td>
              <td>{prices[id] ? prices[id].toFixed(2) : "N/A"} $</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
