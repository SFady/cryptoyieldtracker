let cache = null;
let cacheTime = 0;
const CACHE_DURATION_MS = 60 * 1000; // 60 secondes

export async function GET() {
  const now = Date.now();

  if (cache && now - cacheTime < CACHE_DURATION_MS) {
    return new Response(JSON.stringify(cache), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const ids = [
    "bitcoin", "ethereum", "usd-coin", "chainlink", "aave", "yearn-finance",
    "injective-protocol", "pendle", "render-token", "blockstack", "bittensor",
    "reserve-rights-token", "syrup", "akash-network", "nervos-network", "gamercoin",
    "aerodrome-finance", "kaspa", "io", "alephium", "coredaoorg", "ankr",
    "qubic-network", "nosana", "hatom", "defit", "jito-governance-token",
    "ondo-finance", "solana", "pyth-network"
  ];

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`,
      {
        headers: {
          "x-cg-demo-api-key": process.env.NEXT_PUBLIC_COINGECKO_API_KEY,
        },
      }
    );

    if (!res.ok) {
      const text = await res.text();
      return new Response(JSON.stringify({ error: `CoinGecko ${res.status}: ${text.trim()}` }), {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    const data = await res.json();
    cache = data;
    cacheTime = now;

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: "Erreur serveur: " + error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
