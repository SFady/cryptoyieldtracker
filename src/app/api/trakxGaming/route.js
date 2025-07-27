// /app/api/trakxMemes/route.js

export async function GET() {
  try {
    const res = await fetch("https://marketdata.trakx.io/Prices/Current?keys=l1game&quoteCurrency=usdc");

    if (!res.ok) {
      return new Response(JSON.stringify({ error: "Erreur API Gaming Trakx" }), {
        status: res.status,
      });
    }

    const data = await res.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: "Erreur serveur: " + error.message }), {
      status: 500,
    });
  }
}
