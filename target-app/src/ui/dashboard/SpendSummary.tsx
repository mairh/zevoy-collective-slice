import type { Expense } from "../../types/expense";
import { Money } from "../common/Money";
import { Panel } from "../common/Panel";

/** Month-to-date approved spend. */
export function SpendSummary({ expenses }: { expenses: Expense[] }) {
  const approvedMinor = expenses
    .filter((expense) => expense.status === "approved")
    .reduce((sum, expense) => sum + expense.amount.amountMinor, 0);
  return (
    <Panel title="Spend this month">
      <Money amount={{ amountMinor: approvedMinor, currency: "EUR" }} />
    </Panel>
  );
}
