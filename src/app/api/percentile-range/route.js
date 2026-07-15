import { getPercentileRange } from "../../lib/cronKv";

export const runtime = "nodejs";

export async function GET() {
  try {
    const pct = await getPercentileRange();
    if (!pct || pct.cnt < 10 || pct.p05 <= 0)
      return Response.json({ error: "Données insuffisantes", cnt: pct?.cnt ?? 0 }, { status: 422 });
    const rangePct = parseFloat(Math.max(2, ((pct.p95 - pct.p05) / pct.p05) * 100).toFixed(2));
    return Response.json({ rangePct, p05: pct.p05, p95: pct.p95, cnt: pct.cnt });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
