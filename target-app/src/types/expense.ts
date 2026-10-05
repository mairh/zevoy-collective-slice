import type { Money } from "./money";

export type ExpenseStatus = "draft" | "submitted" | "approved" | "rejected";

export interface Expense {
  id: string;
  merchant: string;
  amount: Money;
  category: string;
  status: ExpenseStatus;
  receiptId: string | null;
  occurredAt: string;
}

export interface NewExpense {
  merchant: string;
  amount: Money;
  category: string;
  occurredAt: string;
}
