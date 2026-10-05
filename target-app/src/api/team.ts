import type { User } from "../types/user";
import { apiClient } from "./client";

/** Returns the signed-in user. */
export function getCurrentUser(): Promise<User> {
  return apiClient.get<User>("/users/me");
}

/** Lists members of the current company. */
export function listTeamMembers(): Promise<User[]> {
  return apiClient.get<User[]>("/team");
}
