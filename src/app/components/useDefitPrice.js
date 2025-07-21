import { useEffect, useState } from "react";

export function useDefitPrice() {
  const [price, setPrice] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function fetchPrice() {
      try {
        const res = await fetch(
          "https://api.coingecko.com/api/v3/simple/token_price/polygon-pos?contract_addresses=0x428360b02c1269bc1c79fbc399ad31d58c1e8fda&vs_currencies=usd",
          {
            headers: {
              "x-cg-demo-api-key": process.env.NEXT_PUBLIC_COINGECKO_API_KEY,
            },
          }
        );
        const data = await res.json();
        const tokenData = data["0x428360b02c1269bc1c79fbc399ad31d58c1e8fda"];
        if (tokenData?.usd) {
          setPrice(Number(tokenData.usd));
        } else {
          setError("Prix introuvable");
        }
      } catch {
        setError("Erreur de chargement");
      }
    }

    fetchPrice();
  }, []);

  return { price, error };
}
