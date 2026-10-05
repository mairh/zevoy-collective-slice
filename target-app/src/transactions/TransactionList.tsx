import { TransactionRow } from "./TransactionRow";
import { useTransactions } from "./useTransactions";

/** Posted transactions for one card, newest first. */
export function TransactionList({ cardId }: { cardId: string }) {
  const transactions = useTransactions(cardId);
  return (
    <ul>
      {transactions.map((transaction) => (
        <TransactionRow key={transaction.id} transaction={transaction} />
      ))}
    </ul>
  );
}
