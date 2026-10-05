import { useEffect, useState } from "react";
import { listExpenses } from "../../api/expenses";
import { useCurrentUser } from "../../auth/AuthProvider";
import type { Expense } from "../../types/expense";
import { SpendSummary } from "./SpendSummary";

/** Landing page after sign-in. */
export function Dashboard() {
  const user = useCurrentUser();
  const [expenses, setExpenses] = useState<Expense[]>([]);
  useEffect(() => {
    listExpenses().then(setExpenses);
  }, []);
  return (
    <main>
      <h1>{user ? `Hello, ${user.name}` : "Hello"}</h1>
      <SpendSummary expenses={expenses} />
    </main>
  );
}
