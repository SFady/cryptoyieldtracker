"use client";
import { useEffect } from "react";
import { setSession } from "../actions/setSession";

export default function InitSession() {
  useEffect(() => {
    setSession(); // ✅ autorisé car déclenché côté client
  }, []);

  return null;
}
