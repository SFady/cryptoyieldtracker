import { cookies } from "next/headers";

export default async function checkAuthent() {
  const cookieStore = await cookies();  // await ici
  const existing = cookieStore.get("session");  // get est synchrone

  if (existing) return true;

  return false;
}
