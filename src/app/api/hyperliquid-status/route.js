import { ethers } from "ethers";

export const runtime = "nodejs";

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

export async function GET() {
  const privateKey = process.env.PRIVATE_KEY_HL1;
  if (!privateKey) return Response.json({ error: "PRIVATE_KEY_HL1 manquant" }, { status: 500 });

  let address;
  try {
    address = new ethers.Wallet(privateKey.trim()).address;
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }

  try {
    const [state, openOrders, mids] = await Promise.all([
      hlInfo({ type: "clearinghouseState", user: address }),
      hlInfo({ type: "openOrders",         user: address }),
      hlInfo({ type: "allMids" }),
    ]);

    const accountValue = parseFloat(state.marginSummary?.accountValue ?? 0);
    const withdrawable = parseFloat(state.withdrawable ?? 0);

    const positions = (state.assetPositions ?? [])
      .filter(p => parseFloat(p.position.szi) !== 0)
      .map(({ position: pos }) => ({
        coin:      pos.coin,
        side:      parseFloat(pos.szi) > 0 ? "long" : "short",
        szi:       Math.abs(parseFloat(pos.szi)),
        sizeUSD:   parseFloat(pos.positionValue ?? 0),
        entryPx:   parseFloat(pos.entryPx ?? 0),
        markPx:    parseFloat(mids[pos.coin] ?? 0),
        pnl:       parseFloat(pos.unrealizedPnl ?? 0),
        funding:   parseFloat(pos.cumFunding?.sinceOpen ?? 0),
        leverage:  pos.leverage?.value ?? 1,
        margin:    parseFloat(pos.marginUsed ?? 0),
      }));

    const orders = (Array.isArray(openOrders) ? openOrders : []).map(o => {
      const mid = parseFloat(mids[o.coin] ?? 0);
      const sz  = parseFloat(o.sz ?? 0);
      return {
        coin:      o.coin,
        side:      o.side === "B" ? "buy" : "sell",
        orderType: o.orderType ?? "Limit",
        sz,
        sizeUSD:   mid ? parseFloat((sz * mid).toFixed(2)) : null,
        limitPx:   parseFloat(o.limitPx ?? 0),
        triggerPx: o.triggerPx ? parseFloat(o.triggerPx) : null,
        tpsl:      o.tpsl ?? null,
      };
    });

    return Response.json({ address, accountValue, withdrawable, positions, openOrders: orders });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
