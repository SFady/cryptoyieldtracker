"use client";

import { useEffect, useState } from "react";

const TOKEN_IDS = {
  bitcoin: "BTC",
  ethereum: "ETH",
};

// Helper to format Date object to dd-mm-yyyy for CoinGecko API
function formatDate(date) {
  return date.toLocaleDateString("en-GB").split("/").join("-");
}

/**
 * Hook to fetch historical prices for tokens at a given date
 * @param {Date} date - The historical date to fetch prices for
 */
export function useHistoricalCryptoPrices(date) {
  const [prices, setPrices] = useState({});
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!date) return; // no date, do nothing

    async function fetchHistoricalPrices() {
      try {
        const newPrices = {};

        // Fetch each token's historical price one by one (CoinGecko does not support batch historical)
        for (const tokenId of Object.keys(TOKEN_IDS)) {
          const formattedDate = formatDate(date);
          const res = await fetch(
            `https://api.coingecko.com/api/v3/coins/${tokenId}/history?date=${formattedDate}`,
            {
              headers: {
                "x-cg-demo-api-key": process.env.NEXT_PUBLIC_COINGECKO_API_KEY,
              },
            }
          );

          if (!res.ok) {
            throw new Error(`Failed to fetch historical price for ${tokenId}`);
          }

          const data = await res.json();

          // Extract USD price if available
          newPrices[tokenId] =
            data?.market_data?.current_price?.usd ?? null;
        }

        setPrices(newPrices);
        setError(null);
      } catch (err) {
        setError("Error loading historical prices");
        setPrices({});
      }
    }

    fetchHistoricalPrices();
  }, [date]);

  return { prices, error, tokenMap: TOKEN_IDS };
}
