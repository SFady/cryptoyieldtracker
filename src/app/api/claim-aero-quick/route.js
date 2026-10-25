export const runtime     = 'nodejs';
export const maxDuration = 30;

// POST /api/claim-aero-quick
// Désactivé (25/10) — route legacy jamais migrée vers le nouveau protocole Aero (VOTER/ancien
// AERO/getReward d'avant la fusion du 21/10). Plus de risque de perte à laisser une route non
// auditée pouvoir encore envoyer des transactions réelles.
export async function POST(req) {
  return Response.json({ error: "Route désactivée — non migrée vers le nouveau protocole Aero" }, { status: 410 });
}
