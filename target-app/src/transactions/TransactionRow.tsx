import { formatDate } from "../lib/dates";
import { Money } from "../ui/common/Money";
import type { Transaction } from "./useTransactions";

/** One posted card transaction. */
export function TransactionRow({ transaction }: { transaction: Transaction }) {
  return (
    <li>
      <span>{transaction.merchant}</span>
      <span>{formatDate(transaction.postedAt)}</span>
      <Money amount={transaction.amount} />
    </li>
  );
}
