import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";

const sql = neon(process.env.DATABASE_URL);

export async function GET() {
  try {
    const rows = await sql`
      SELECT id, action1, action2, error_msg, created_at
      FROM lp_events
      WHERE action1 != 'RUNNING'
      ORDER BY id DESC
      LIMIT 1
    `;
    return Response.json({ lastRow: rows[0] ?? null });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
