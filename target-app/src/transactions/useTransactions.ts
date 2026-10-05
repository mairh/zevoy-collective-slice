import { useEffect, useState } from "react";
import { apiClient } from "../api/client";
import type { Money } from "../types/money";

export interface Transaction {
  id: string;
  cardId: string;
  merchant: string;
  amount: Money;
  postedAt: string;
}

/** Loads posted transactions for a card. */
export function useTransactions(cardId: string): Transaction[] {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  useEffect(() => {
    apiClient.get<Transaction[]>(`/cards/${cardId}/transactions`).then(setTransactions);
  }, [cardId]);
  return transactions;
}
