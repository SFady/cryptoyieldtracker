import { neon } from '@neondatabase/serverless';

export const runtime = 'nodejs';

export async function GET() {
  const sql = neon(process.env.DATABASE_URL);
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS algo_settings (
        key   TEXT PRIMARY KEY,
        value NUMERIC(12,4) NOT NULL
      )
    `;
    return Response.json({ ok: true, message: 'Table algo_settings créée' });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
