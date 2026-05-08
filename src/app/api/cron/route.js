import { neon } from "@neondatabase/serverless";

export const runtime     = "nodejs";
export const maxDuration = 10;

const sql = neon(process.env.DATABASE_URL);

export async function GET(req) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth  = req.headers.get("authorization") ?? "";
    const query = new URL(req.url).searchParams.get("secret") ?? "";
    if (auth !== `Bearer ${secret}` && query !== secret)
      return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ranAt = new Date().toISOString();

  try {
    await sql`INSERT INTO cron_runs (ran_at) VALUES (NOW())`;
  } catch (_) {}

  return Response.json({ ok: true, ranAt });
}
