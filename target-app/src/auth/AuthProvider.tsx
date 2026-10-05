import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { getCurrentUser } from "../api/team";
import type { User } from "../types/user";

const AuthContext = createContext<User | null>(null);

/** Loads the signed-in user once and exposes it to the tree. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => {
    getCurrentUser().then(setUser);
  }, []);
  return <AuthContext.Provider value={user}>{children}</AuthContext.Provider>;
}

/** Returns the signed-in user, or null while loading. */
export function useCurrentUser(): User | null {
  return useContext(AuthContext);
}
