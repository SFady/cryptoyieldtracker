"use client";

import { useEffect, useState } from "react";

const TOKEN_IDS = {
  bitcoin: "BTC",
  ethereum: "ETH",
};

export function useCryptoPrices() {
  const [prices, setPrices] = useState({});
  const [error, setError] = useState(null);

  useEffect(() => {
    async function fetchPrices() {
      try {
        const res = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${Object.keys(TOKEN_IDS).join(",")}&vs_currencies=usd`,
          {
            headers: {
              "x-cg-demo-api-key": process.env.NEXT_PUBLIC_COINGECKO_API_KEY,
            },
          }
        );
        const data = await res.json();

        const newPrices = {};
        for (const [id, info] of Object.entries(data)) {
          newPrices[id] = info.usd || null;
        }
        setPrices(newPrices);
      } catch {
        setError("Error loading prices");
      }
    }

    fetchPrices();
  }, []);

  return { prices, error, tokenMap: TOKEN_IDS };
}
