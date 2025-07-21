"use client";

import React from "react";
import { useCryptoPrices } from "../components/useCryptoPrices"; // adjust path

export default function ProfilePage() {
  const { prices, error, tokenMap } = useCryptoPrices();

  if (error) return <p>{error}</p>;
  if (Object.keys(prices).length === 0) return <p>Loading...</p>;

  return (
    <ul>
      {Object.entries(tokenMap).map(([id, symbol]) => (
        <li key={id}>
          {symbol}: ${prices[id] ? prices[id].toFixed(4) : "N/A"}
        </li>
      ))}
    </ul>
  );
}
