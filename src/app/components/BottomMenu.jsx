"use client";

import React from "react";
import Link from "next/link";
import { useAuth } from "../context/AuthContext";

const BottomMenu = ({ selected }) => {
  const { activeUser } = useAuth();
  const isSupervisor = activeUser === "set3";

  return (
    <nav className="bottom-menu">
      <Link
        href="/home"
        aria-label="Accueil"
        className={`button ${selected === "home" ? "active" : ""}`}
      >
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
        </svg>
        Accueil
      </Link>

      {isSupervisor && (
        <Link
          href="/activities"
          aria-label="Activités"
          className={`button ${selected === "activities" ? "active" : ""}`}
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16a6.471 6.471 0 004.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5z" />
          </svg>
          Bots
        </Link>
      )}

      {isSupervisor && (
        <Link
          href="/profile"
          aria-label="Divers"
          className={`button ${selected === "profile" ? "active" : ""}`}
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
          </svg>
          Pools
        </Link>
      )}

      {isSupervisor && (
        <Link
          href="/test"
          aria-label="Test"
          className={`button ${selected === "test" ? "active" : ""}`}
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.428 15.428a2 2 0 0 0-1.022-.547l-2.387-.477a6 6 0 0 0-3.86.517l-.318.158a6 6 0 0 1-3.86.517L6.05 15.21a2 2 0 0 0-1.806.547M8 4h8l-1 1v5.172a2 2 0 0 0 .586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 0 0 9 10.172V5L8 4z" />
          </svg>
          Test
        </Link>
      )}
    </nav>
  );
};

export default BottomMenu;
