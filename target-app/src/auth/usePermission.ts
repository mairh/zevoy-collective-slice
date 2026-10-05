import type { Permission } from "../types/user";
import { useCurrentUser } from "./AuthProvider";

/** True when the signed-in user holds the given permission. */
export function usePermission(permission: Permission): boolean {
  const user = useCurrentUser();
  return user !== null && user.permissions.includes(permission);
}
