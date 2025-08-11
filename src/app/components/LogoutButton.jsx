"use client";

import { logout } from "../actions/logout";

export default function LogoutButton() {
  return (
    <button
      onClick={async () => {
        window.history.scrollRestoration = "manual";
        await logout();
            window.scrollTo({ top: 0, behavior: "smooth" }); // remonte en haut
        window.location.reload(); // refresh page after logout
      }}
    >
      Logout
    </button>
  );
}
