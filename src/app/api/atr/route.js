export async function GET() {
  try {
    const url =
      "https://api.coingecko.com/api/v3/coins/ethereum/ohlc?vs_currency=usd&days=7";

    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      next: { revalidate: 300 },
    });

    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);

    // [[timestamp, open, high, low, close], ...]
    const ohlc = await res.json();

    if (!Array.isArray(ohlc) || ohlc.length < 2) {
      return Response.json({ error: "Données insuffisantes" }, { status: 500 });
    }

    const PERIODS = 14;
    const candles = ohlc.slice(-(PERIODS + 1));

    const trueRanges = [];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i][2];
      const low = candles[i][3];
      const prevClose = candles[i - 1][4];
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trueRanges.push(tr);
    }

    const usedPeriods = Math.min(PERIODS, trueRanges.length);
    const atr = trueRanges.slice(-usedPeriods).reduce((a, b) => a + b, 0) / usedPeriods;

    const lastCandle = candles[candles.length - 1];
    const price = lastCandle[4];
    const atrPct = (atr / price) * 100;

    // Volatility label
    let volatility;
    if (atrPct < 2) volatility = "Calme";
    else if (atrPct < 4) volatility = "Normal";
    else if (atrPct < 7) volatility = "Agité";
    else volatility = "Très volatile";

    return Response.json({
      price: parseFloat(price.toFixed(2)),
      atr: parseFloat(atr.toFixed(2)),
      atrPct: parseFloat(atrPct.toFixed(3)),
      range1x: parseFloat(atrPct.toFixed(2)),
      range2x: parseFloat((atrPct * 2).toFixed(2)),
      range25x: parseFloat((atrPct * 2.5).toFixed(2)),
      volatility,
      periods: usedPeriods,
      interval: "4h",
      candleCount: ohlc.length,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
