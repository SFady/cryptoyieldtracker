import { cookies } from "next/headers";

export default async function checkAuthent() {
  const cookieStore = await cookies();  // await ici
  const existing = cookieStore.get("session");  // get est synchrone

  // console.log(existing);

  if (existing) return existing.value;

  return "";
}
