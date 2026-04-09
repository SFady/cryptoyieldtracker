"use client";

import { logout } from "../actions/logout";

export default function LogoutButton() {
  return (
    <button
      onClick={async () => {
        window.history.scrollRestoration = "manual";
        await logout();
        window.scrollTo({ top: 0, behavior: "smooth" });
        window.location.reload();
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        background: "rgba(255, 80, 80, 0.08)",
        border: "1px solid rgba(255, 80, 80, 0.25)",
        borderRadius: "10px",
        padding: "9px 18px",
        color: "#ff6b6b",
        fontSize: "0.85rem",
        fontWeight: 600,
        cursor: "pointer",
        letterSpacing: "0.04em",
        transition: "background 0.2s, border-color 0.2s",
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = "rgba(255, 80, 80, 0.18)";
        e.currentTarget.style.borderColor = "rgba(255, 80, 80, 0.5)";
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = "rgba(255, 80, 80, 0.08)";
        e.currentTarget.style.borderColor = "rgba(255, 80, 80, 0.25)";
      }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <polyline points="16 17 21 12 16 7" />
        <line x1="21" y1="12" x2="9" y2="12" />
      </svg>
      Déconnexion
    </button>
  );
}
