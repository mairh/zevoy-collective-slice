import type { Money } from "./money";

export type CardStatus = "active" | "frozen" | "cancelled";

export interface Card {
  id: string;
  last4: string;
  holderName: string;
  nickname: string;
  status: CardStatus;
  onlineEnabled: boolean;
  contactlessEnabled: boolean;
  monthlyLimit: Money;
  transactionLimit: Money | null;
}

/** Fields a cardholder may change. Mirrors CardSettingsUpdate in the OpenAPI contract. */
export interface CardSettingsUpdate {
  nickname?: string;
  onlineEnabled?: boolean;
  contactlessEnabled?: boolean;
  transactionLimit?: Money | null;
}
