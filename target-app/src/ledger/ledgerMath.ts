import type { Money } from "../types/money";

export interface LedgerEntry {
  id: string;
  description: string;
  debit: Money | null;
  credit: Money | null;
}

/** Running balance in minor units. Debits reduce, credits increase. */
export function runningBalance(entries: LedgerEntry[]): number[] {
  let balance = 0;
  return entries.map((entry) => {
    balance += (entry.credit?.amountMinor ?? 0) - (entry.debit?.amountMinor ?? 0);
    return balance;
  });
}
