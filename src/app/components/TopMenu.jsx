"use client";

import React from "react";
import Link from "next/link";
import { useAuth } from "../context/AuthContext";
import { logout } from "../actions/logout";

export default function TopMenu({ selected, onSelect }) {
  const { activeUser } = useAuth();

  return (
    <header className="header">
      <div className="logo">
        <img src="/images/bitcoin.png" alt="Logo" className="logo-icon" />
        <h1 className="crypto-title">Crypto Yield Tracker</h1>
      </div>

      <div className="header-right">
        <nav className="nav-top-menu">
          <Link
            href="/home"
            className={selected === "home" ? "active" : ""}
            onClick={() => onSelect && onSelect("home")}
            aria-current={selected === "home" ? "page" : undefined}
          >
            Home
          </Link>
          <Link
            href="/activities"
            className={selected === "activities" ? "active" : ""}
            onClick={() => onSelect && onSelect("activities")}
            aria-current={selected === "activities" ? "page" : undefined}
          >
            Menu2
          </Link>
          <Link
            href="/home"
            className={selected === "profile" ? "active" : ""}
            onClick={() => onSelect && onSelect("profile")}
            aria-current={selected === "profile" ? "page" : undefined}
          >
            Menu3
          </Link>
        </nav>

        {activeUser && (
          <button
            className="logout-btn"
            onClick={async () => {
              await logout();
              window.location.reload();
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span>Déconnexion</span>
          </button>
        )}
      </div>
    </header>
  );
}
