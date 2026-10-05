import { createBankingClient } from "../banking/bankingClient";

/**
 * The single sanctioned wrapper around the banking client. UI code must never import
 * the banking client directly; the ast-validation gate enforces that.
 */
const banking = createBankingClient({ baseUrl: "/api/v1/banking" });

export interface SettlementStatus {
  settled: boolean;
  settledAt: string | null;
}

/** Looks up whether a card payment has settled with the issuing bank. */
export function getSettlementStatus(paymentId: string): Promise<SettlementStatus> {
  return banking.settlement(paymentId);
}
