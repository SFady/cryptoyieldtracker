"use server";

import { cookies } from "next/headers";

export async function login(formData) {
  const username = formData.get("username");
  const password = formData.get("password");

  // 🔒 Ici tu mets ta logique de vérification
  if (username === "Bmenez" && password === "bm190283@#") {
    cookies().set({
      name: "session",
      value: "set1",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 365 * 60 * 60 * 24, // 365 jours
    });
    return { success: true };
  }

  if (username.toLowerCase() === "sab" && password === "sb250472@#") {
    cookies().set({
      name: "session",
      value: "set2",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 365 * 60 * 60 * 24, // 365 jours
    });
    return { success: true };
  }

  if (username === "supervisorsfy" && password === "Sup102456@#") {
    cookies().set({
      name: "session",
      value: "set3",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 365 * 60 * 60 * 24, // 365 jours
    });
    return { success: true };
  }

  return { success: false };
}
