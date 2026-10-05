import { formatMoney } from "../lib/money";
import { type LedgerEntry, runningBalance } from "./ledgerMath";

/** Read-only company ledger with a running balance column. */
export function LedgerTable({ entries }: { entries: LedgerEntry[] }) {
  const balances = runningBalance(entries);
  return (
    <table>
      <tbody>
        {entries.map((entry, index) => (
          <tr key={entry.id}>
            <td>{entry.description}</td>
            <td>{entry.debit ? formatMoney(entry.debit) : ""}</td>
            <td>{entry.credit ? formatMoney(entry.credit) : ""}</td>
            <td>{formatMoney({ amountMinor: balances[index] ?? 0, currency: "EUR" })}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
