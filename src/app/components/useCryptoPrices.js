import { useEffect, useState } from "react";

// A quoi sert la 2 eme partie ?
const TOKEN_IDS = {
  bitcoin: "bitcoin",
  ethereum: "ethereum",
  "usd-coin": "usd-coin",
  chainlink: "chainlink",
  aave: "aave",
  "yearn-finance": "yearn-finance",
  injective: "INJ",       // spécial Binance
  pendle: "pendle",
  "render-token": "render-token",
  stacks: "STX",           // spécial Binance
  "fetch-ai": "fetch-ai",
  bittensor: "bittensor",
  "reserve-rights-token": "reserve-rights-token",  // RSR
  syrup: "syrup",                       // SYRUP (vérifier ID exact)
  "akash-network": "akash-network",    // AKT
  "nervos-network": "nervos-network",  // CKB
  "gamercoin": "ghx",          // GHX (vérifier ID exact)
   "aerodrome-finance": "aerodrome-finance", // AERO
  kaspa: "kaspa",                      // KAS
  "io": "io",                  // IO
  alephium: "alephium",                // ALPH
  coredaoorg: "Core",                  // CORE
  ankr: "ankr",                        // ANKR
  "qubic-network": "qubic-network",
  nosana: "nosana",
  hatom: "hatom",
  defit: "defit",
};

export function useCryptoPrices() {
  const [prices, setPrices] = useState({});
  const [error, setError] = useState(null);

  useEffect(() => {
    async function fetchPrices() {
      try {
        // IDs CoinGecko sauf INJ et STX
        const coingeckoIds = Object.keys(TOKEN_IDS).filter(
          (id) => id !== "injective" && id !== "stacks"
        );

        // Fetch CoinGecko prices
        const res = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoIds.join(
            ","
          )}&vs_currencies=usd`,
            {
            headers: {
              "x-cg-demo-api-key": process.env.NEXT_PUBLIC_COINGECKO_API_KEY,
            },
          }
        );
        const data = await res.json();
        // console.log(data);

        const newPrices = {};
        for (const [id, info] of Object.entries(data)) {
          newPrices[id] = info.usd || null;
        }

        // Fetch INJ price from Binance
        const injRes = await fetch(
          "https://api.binance.com/api/v3/ticker/price?symbol=INJUSDT"
        );
        if (!injRes.ok) throw new Error("Erreur réseau Binance INJ");
        const injData = await injRes.json();
        newPrices["injective"] = parseFloat(injData.price);

        // Fetch STX price from Binance
        const stxRes = await fetch(
          "https://api.binance.com/api/v3/ticker/price?symbol=STXUSDT"
        );
        if (!stxRes.ok) throw new Error("Erreur réseau Binance STX");
        const stxData = await stxRes.json();
        newPrices["stacks"] = parseFloat(stxData.price);

        try {
        const trakxMemesRes = await fetch("/api/trakxMemes");
        const trakxMemesData = await trakxMemesRes.json();
        if (trakxMemesData && trakxMemesData.l1meme) {
          newPrices["trakxMemes"] = parseFloat(trakxMemesData.l1meme);
        }
        } catch (e) {
          console.warn("Erreur fetch trakxMemes via API route:", e.message);
        }

        try {
        const trakxGamingRes = await fetch("/api/trakxGaming");
        const trakxGamingData = await trakxGamingRes.json();
        if (trakxGamingData && trakxGamingData.l1game) {
          newPrices["trakxGaming"] = parseFloat(trakxGamingData.l1game);
        }
        } catch (e) {
          console.warn("Erreur fetch trakxGaming via API route:", e.message);
        }
        
        setPrices(newPrices);
      } catch (err) {
        setError(err.message || "Erreur chargement des prix");
      }
    }

    fetchPrices();
  }, []);

  return { prices, error, tokenMap: TOKEN_IDS };
}
