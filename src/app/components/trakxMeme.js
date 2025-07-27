export default async function handler(req, res) {
  try {
    const trakxRes = await fetch(
      "https://marketdata.trakx.io/Prices/Current?keys=l1meme&quoteCurrency=usdc"
    );
    if (!trakxRes.ok) {
      return res.status(500).json({ error: "Erreur Trakx" });
    }

    const data = await trakxRes.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
