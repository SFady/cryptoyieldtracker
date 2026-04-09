"use client";

import { useState } from "react";
import { login } from "../actions/login";

export default function LoginForm() {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const formData = new FormData(e.target);
    const result = await login(formData);

    if (result.success) {
      window.location.reload();
    } else {
      setError("Identifiants incorrects");
      setLoading(false);
    }
  }

  return (
    <div style={{
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      minHeight: "70vh",
    }}>
      <div style={{
        background: "linear-gradient(145deg, #0d1321, #141a2e)",
        border: "1px solid rgba(0, 255, 204, 0.15)",
        borderRadius: "20px",
        padding: "48px 40px",
        width: "100%",
        maxWidth: "400px",
        boxShadow: "0 0 40px rgba(0, 255, 204, 0.05), 0 20px 60px rgba(0,0,0,0.5)",
      }}>
        {/* Logo / titre */}
        <div style={{ textAlign: "center", marginBottom: "36px" }}>
          <div style={{ fontSize: "2.8rem", marginBottom: "10px" }}>📈</div>
          <h1 style={{
            fontSize: "1.4rem",
            fontWeight: 800,
            color: "#EAF6FF",
            letterSpacing: "0.08em",
            margin: 0,
          }}>Crypto Yield Tracker</h1>
          <p style={{ color: "#5a7a8a", fontSize: "0.85rem", marginTop: "6px" }}>

          </p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* Username */}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <label style={{ fontSize: "0.8rem", color: "#8aa0b0", letterSpacing: "0.05em" }}>
              IDENTIFIANT
            </label>
            <input
              type="text"
              name="username"
              placeholder="Nom d'utilisateur"
              required
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: "10px",
                padding: "13px 16px",
                color: "#EAF6FF",
                fontSize: "0.95rem",
                outline: "none",
                transition: "border-color 0.2s",
                width: "100%",
                boxSizing: "border-box",
              }}
              onFocus={e => e.target.style.borderColor = "rgba(0,255,204,0.5)"}
              onBlur={e => e.target.style.borderColor = "rgba(255,255,255,0.1)"}
            />
          </div>

          {/* Password */}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <label style={{ fontSize: "0.8rem", color: "#8aa0b0", letterSpacing: "0.05em" }}>
              MOT DE PASSE
            </label>
            <div style={{ position: "relative" }}>
              <input
                type={showPassword ? "text" : "password"}
                name="password"
                placeholder="••••••••"
                required
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: "10px",
                  padding: "13px 44px 13px 16px",
                  color: "#EAF6FF",
                  fontSize: "0.95rem",
                  outline: "none",
                  transition: "border-color 0.2s",
                  width: "100%",
                  boxSizing: "border-box",
                }}
                onFocus={e => e.target.style.borderColor = "rgba(0,255,204,0.5)"}
                onBlur={e => e.target.style.borderColor = "rgba(255,255,255,0.1)"}
              />
              <button
                type="button"
                onClick={() => setShowPassword(v => !v)}
                style={{
                  position: "absolute",
                  right: "12px",
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "#5a7a8a",
                  fontSize: "1.1rem",
                  padding: 0,
                }}
              >
                {showPassword ? "🙈" : "👁️"}
              </button>
            </div>
          </div>

          {/* Erreur */}
          {error && (
            <div style={{
              background: "rgba(255, 60, 60, 0.1)",
              border: "1px solid rgba(255, 60, 60, 0.3)",
              borderRadius: "8px",
              padding: "10px 14px",
              color: "#ff6b6b",
              fontSize: "0.85rem",
            }}>
              ⚠️ {error}
            </div>
          )}

          {/* Bouton */}
          <button
            type="submit"
            disabled={loading}
            style={{
              marginTop: "8px",
              background: loading
                ? "rgba(0,255,204,0.2)"
                : "linear-gradient(135deg, #00ffcc, #00b4d8)",
              border: "none",
              borderRadius: "10px",
              padding: "14px",
              color: loading ? "#aaa" : "#0A0F1A",
              fontWeight: 700,
              fontSize: "0.95rem",
              cursor: loading ? "not-allowed" : "pointer",
              letterSpacing: "0.05em",
              transition: "opacity 0.2s",
            }}
          >
            {loading ? "Connexion..." : "Se connecter"}
          </button>
        </form>
      </div>
    </div>
  );
}
