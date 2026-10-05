import type { Expense, NewExpense } from "../types/expense";
import { apiClient } from "./client";

/** Lists the current user's expenses. */
export function listExpenses(): Promise<Expense[]> {
  return apiClient.get<Expense[]>("/expenses");
}

/** Creates a draft expense. */
export function createExpense(expense: NewExpense): Promise<Expense> {
  return apiClient.post<Expense>("/expenses", expense);
}

/** Submits a draft expense for approval. */
export function submitExpense(expenseId: string): Promise<Expense> {
  return apiClient.post<Expense>(`/expenses/${expenseId}/submit`, {});
}
