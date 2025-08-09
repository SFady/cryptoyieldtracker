"use server";

import { cookies } from "next/headers";

export async function setSession() {
  cookies().set({
    name: "session",
    value: "user-333",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 60 * 24, // 1 jour
  });
}
