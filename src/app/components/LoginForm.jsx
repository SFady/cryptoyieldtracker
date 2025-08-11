"use client";

import { useState } from "react";
import { login } from "../actions/login";

export default function LoginForm() {
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    const formData = new FormData(e.target);
    const result = await login(formData);

    if (result.success) {
      window.location.reload(); // recharge pour mettre à jour l'état
    } else {
      setError("Identifiants incorrects");
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div>
        <input type="text" name="username" placeholder="Nom d'utilisateur" required />
      </div>
      <div>
        <input type="password" name="password" placeholder="Mot de passe" required />
      </div>
      <button type="submit">Se connecter</button>
      {error && <p style={{ color: "red" }}>{error}</p>}
    </form>
  );
}
