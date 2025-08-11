"use client"; 
// This must be a client component because React context
// is only accessible in the browser runtime.

import { createContext, useContext } from "react";

// Create the context with a default value
const AuthContext = createContext({ shouldShow: "" });

// Provider component — wraps children and passes down the value
export function AuthProvider({ value, children }) {
  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

// Hook to consume the context in any client component
export function useAuth() {
  return useContext(AuthContext);
}
