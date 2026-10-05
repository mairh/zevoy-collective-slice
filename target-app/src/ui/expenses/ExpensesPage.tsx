import { useEffect, useState } from "react";
import { listExpenses } from "../../api/expenses";
import type { Expense } from "../../types/expense";
import { ExpenseForm } from "./ExpenseForm";
import { ExpenseList } from "./ExpenseList";

/** Expenses page: create and list. */
export function ExpensesPage() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  useEffect(() => {
    listExpenses().then(setExpenses);
  }, []);
  return (
    <div>
      <ExpenseForm onCreated={(expense) => setExpenses((all) => [expense, ...all])} />
      <ExpenseList expenses={expenses} />
    </div>
  );
}
