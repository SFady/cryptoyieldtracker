"use client";

import React from "react";
import Link from "next/link";

export default function TopMenu({ selected, onSelect }) {
  return (
    <header className="header">
      <div className="logo">
        <img src="/images/CAC.png" alt="Logo CAC" className="logo-icon" />
        <h1 className="crypto-title">- Crypto Yield Tracker -</h1>
      </div>
      <nav className="nav-top-menu">
        <Link
          href="/home"
          className={selected === "home" ? "active" : ""}
          onClick={() => onSelect && onSelect("home")}
          aria-current={selected === "home" ? "page" : undefined}
          style={{ marginRight: "1rem" }}
        >
          Home
        </Link>
        <Link
          href="/activities"
          className={selected === "activities" ? "active" : ""}
          onClick={() => onSelect && onSelect("activities")}
          aria-current={selected === "activities" ? "page" : undefined}
          style={{ marginRight: "1rem" }}
        >
          Activities
        </Link>
        <Link
          href="/profile"
          className={selected === "profile" ? "active" : ""}
          onClick={() => onSelect && onSelect("profile")}
          aria-current={selected === "profile" ? "page" : undefined}
        >
          Profile
        </Link>
      </nav>
    </header>
  );
}
