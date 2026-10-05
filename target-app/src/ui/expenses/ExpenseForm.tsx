import { type FormEvent, useState } from "react";
import { createExpense } from "../../api/expenses";
import { toMinorUnits } from "../../lib/money";
import type { Expense } from "../../types/expense";
import { Button } from "../common/Button";
import { Field } from "../common/Field";
import { Panel } from "../common/Panel";
import { TextInput } from "../common/TextInput";

/** Creates a draft expense from merchant, amount and category. */
export function ExpenseForm({ onCreated }: { onCreated: (expense: Expense) => void }) {
  const [merchant, setMerchant] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("travel");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amountMinor = toMinorUnits(amount);
    if (amountMinor === null) {
      return;
    }
    const expense = await createExpense({
      merchant,
      amount: { amountMinor, currency: "EUR" },
      category,
      occurredAt: new Date().toISOString(),
    });
    onCreated(expense);
  }

  return (
    <Panel title="New expense">
      <form onSubmit={handleSubmit}>
        <Field label="Merchant" htmlFor="expense-merchant">
          <TextInput id="expense-merchant" value={merchant} onChange={setMerchant} />
        </Field>
        <Field label="Amount (EUR)" htmlFor="expense-amount">
          <TextInput id="expense-amount" value={amount} onChange={setAmount} inputMode="decimal" />
        </Field>
        <Field label="Category" htmlFor="expense-category">
          <TextInput id="expense-category" value={category} onChange={setCategory} />
        </Field>
        <Button type="submit">Save draft</Button>
      </form>
    </Panel>
  );
}
