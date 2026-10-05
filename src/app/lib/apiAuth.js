import { cookies } from "next/headers";

// Autorise un appel sur une route qui déplace des fonds (ouverture/fermeture de LP, claim AERO,
// collecte de fees, maintenance) si l'un des deux est vrai :
//   1. Appel serveur-à-serveur authentifié par CRON_SECRET — le bot (loop.js/loop3.js) relaie ce
//      header sur ses propres appels internes à ces routes, même secret que /api/cron.
//   2. Navigateur avec le cookie de session httpOnly du compte autorisé à piloter le bot (set3,
//      cf. actions/login.js) — déjà envoyé automatiquement par le navigateur, aucun changement
//      frontend nécessaire.
// Si CRON_SECRET n'est pas configuré (dev local), se comporte comme avant la sécurisation du
// 05/10 : aucun blocage — même repli que cron/route.js.
export function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;

  const auth  = req.headers.get("authorization") ?? "";
  const query = new URL(req.url).searchParams.get("secret") ?? "";
  if (auth === `Bearer ${secret}` || query === secret) return true;

  const session = cookies().get("session")?.value;
  return session === "set3";
}

export function unauthorizedResponse() {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
