import { POOL_ADDRESS as POOL } from "../../lib/config";

export const runtime     = "nodejs";
export const maxDuration = 10;

const RPC_URLS = [
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
];

export async function GET() {
  for (const url of RPC_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_call",
          params: [{ to: POOL, data: "0x3850c7bd" }, "latest"],
        }),
        signal: AbortSignal.timeout(5000),
      });
      const text = await res.text();
      if (!text) continue;
      const json = JSON.parse(text);
      if (!json.result || json.result === "0x") continue;

      const hex = json.result;
      const sqrtPriceX96 = BigInt("0x" + hex.slice(2, 66));
      const Q96          = 2n ** 96n;
      const price        = Number(sqrtPriceX96 * sqrtPriceX96 * 10n ** 12n / (Q96 * Q96));

      return Response.json({ price: Math.round(price * 100) / 100 });
    } catch (_) {}
  }
  return Response.json({ error: "RPC indisponible" }, { status: 500 });
}
