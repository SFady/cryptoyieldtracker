import { writeErrorState, writeCollectErr } from "../../lib/cronKv";

export const runtime = "nodejs";

export async function POST(req) {
  const { poolNum = 2 } = await req.json().catch(() => ({}));
  await writeErrorState(poolNum, false);
  await writeCollectErr(poolNum, false);
  return Response.json({ ok: true, poolNum });
}
