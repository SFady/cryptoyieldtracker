import { ethers } from "ethers";

export const runtime     = "nodejs";
export const maxDuration = 30;

const HL_INFO = "https://api.hyperliquid.xyz/info";

async function hlInfo(body) {
  const res = await fetch(HL_INFO, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(10000),
  });
  return res.json();
}

// GET /api/hyperliquid-history?coin=ETH&days=30
export async function GET(req) {
  const privateKey = process.env.PRIVATE_KEY_HL1;
  if (!privateKey) return Response.json({ error: "PRIVATE_KEY_HL1 manquant" }, { status: 500 });

  const wallet  = new ethers.Wallet(privateKey.trim());
  const address = wallet.address;

  const { searchParams } = new URL(req.url);
  const coin = searchParams.get("coin") ?? "ETH";
  const days = parseInt(searchParams.get("days") ?? "30", 10);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  const [fills, funding] = await Promise.all([
    hlInfo({ type: "userFills", user: address }),
    hlInfo({ type: "userFunding", user: address, startTime: since }),
  ]);

  // Fills ETH uniquement, filtrés par date
  const ethFills = (Array.isArray(fills) ? fills : [])
    .filter(f => f.coin === coin && f.time >= since)
    .map(f => ({
      time:     new Date(f.time).toISOString(),
      side:     f.side,        // "B" = buy (close short), "A" = sell (open short)
      price:    parseFloat(f.px),
      size:     parseFloat(f.sz),
      fee:      parseFloat(f.fee ?? 0),
      closedPnl: parseFloat(f.closedPnl ?? 0),
      oid:      f.oid,
    }));

  // Funding ETH uniquement
  const ethFunding = (Array.isArray(funding) ? funding : [])
    .filter(f => f.coin === coin)
    .map(f => ({
      time:         new Date(f.time).toISOString(),
      fundingRate:  parseFloat(f.fundingRate ?? 0),
      usdc:         parseFloat(f.usdc ?? 0),
    }));

  // Résumé
  const totalClosedPnl  = ethFills.reduce((s, f) => s + f.closedPnl, 0);
  const totalFees       = ethFills.reduce((s, f) => s + f.fee, 0);
  const totalFunding    = ethFunding.reduce((s, f) => s + f.usdc, 0);
  const netPnl          = totalClosedPnl - totalFees + totalFunding;

  return Response.json({
    address,
    coin,
    period:   `${days} derniers jours`,
    summary: {
      closedPnl:   parseFloat(totalClosedPnl.toFixed(4)),
      fees:        parseFloat((-totalFees).toFixed(4)),
      funding:     parseFloat(totalFunding.toFixed(4)),
      netPnl:      parseFloat(netPnl.toFixed(4)),
    },
    fills:   ethFills,
    funding: ethFunding,
  });
}
