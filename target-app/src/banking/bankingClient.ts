/** Low-level issuer bank client. Handles idempotency keys and signing. Do not import outside src/api/payments.ts. */
export interface BankingClientOptions {
  baseUrl: string;
}

export interface BankingClient {
  settlement(paymentId: string): Promise<{ settled: boolean; settledAt: string | null }>;
}

/** Creates a banking client bound to a base URL. */
export function createBankingClient(options: BankingClientOptions): BankingClient {
  return {
    async settlement(paymentId) {
      const response = await fetch(`${options.baseUrl}/settlements/${paymentId}`, {
        headers: { "idempotency-key": crypto.randomUUID() },
      });
      return (await response.json()) as { settled: boolean; settledAt: string | null };
    },
  };
}
