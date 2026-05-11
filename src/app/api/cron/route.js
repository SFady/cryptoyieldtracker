import { neon } from "@neondatabase/serverless";

export const runtime     = "nodejs";
export const maxDuration = 10;

const sql = neon(process.env.DATABASE_URL);

function checkAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth  = req.headers.get("authorization") ?? "";
  const query = new URL(req.url).searchParams.get("secret") ?? "";
  return auth === `Bearer ${secret}` || query === secret;
}

async function handle(req) {
  if (!checkAuth(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const ranAt = new Date().toISOString();
  try { await sql`INSERT INTO cron_runs (ran_at) VALUES (NOW())`; } catch (_) {}
  return Response.json({ ok: true, ranAt });
}

export const GET  = handle;
export const POST = handle;
