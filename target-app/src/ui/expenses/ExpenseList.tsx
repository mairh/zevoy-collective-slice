import { submitExpense } from "../../api/expenses";
import { formatDate } from "../../lib/dates";
import type { Expense } from "../../types/expense";
import { Button } from "../common/Button";
import { Money } from "../common/Money";
import { ReceiptUpload } from "./ReceiptUpload";

/** The user's expenses with submit and receipt actions. */
export function ExpenseList({ expenses }: { expenses: Expense[] }) {
  return (
    <ul>
      {expenses.map((expense) => (
        <li key={expense.id}>
          <span>{expense.merchant}</span>
          <span>{formatDate(expense.occurredAt)}</span>
          <Money amount={expense.amount} />
          {expense.receiptId === null ? <ReceiptUpload expenseId={expense.id} /> : null}
          {expense.status === "draft" ? <Button onClick={() => submitExpense(expense.id)}>Submit</Button> : null}
        </li>
      ))}
    </ul>
  );
}
