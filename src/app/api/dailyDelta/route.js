export const runtime = "nodejs";

// ── État serveur ──────────────────────────────────────────────────────────────
// Tout est généré une seule fois par jour côté serveur.
// "accumulated" = bruit journalier (0–1 %) + delta cumulé (±0.30 %/jour)
// Résultat stable jusqu'au prochain changement de date.

let lastDate    = null;
let accumulated = Array(15).fill(0); // valeur totale à ajouter à gainsFixes

function todayKey() {
  return new Date().toISOString().split("T")[0]; // "YYYY-MM-DD"
}

function maybeUpdate() {
  const today = todayKey();
  if (lastDate === today) return; // déjà généré pour aujourd'hui

  lastDate = today;

  // Bruit journalier stable (remplace le Math.random() côté client) : 0 – 1 %
  const noise = Array(15)
    .fill(0)
    .map(() => parseFloat((Math.random()).toFixed(2)));

  // Delta de tendance : ±0.30 % par bot
  const trend = Array(15)
    .fill(0)
    .map(() => parseFloat(((Math.random() * 0.6) - 0.3).toFixed(2)));

  accumulated = accumulated.map((acc, i) =>
    parseFloat((acc + noise[i] + trend[i]).toFixed(2))
  );
}

export async function GET() {
  maybeUpdate();

  return Response.json({
    date:        lastDate,
    accumulated,
  });
}
