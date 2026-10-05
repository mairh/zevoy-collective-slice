export type Role = "employee" | "approver" | "admin";

export type Permission = "cards:manage" | "expenses:approve" | "ledger:read" | "team:manage";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  permissions: Permission[];
}
