import { neon } from '@neondatabase/serverless';

export const runtime = 'nodejs';

export async function GET() {
  const sql = neon(process.env.DATABASE_URL);
  try {
    await sql`ALTER TABLE lp_events ADD COLUMN IF NOT EXISTS total_at_open NUMERIC(12,2)`;
    return Response.json({ ok: true, message: 'Colonne total_at_open ajoutée à lp_events' });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
