import type { Card } from "../../types/card";
import { CardSettingsPanel } from "./CardSettingsPanel";

const card: Card = {
  id: "card_7f3a",
  last4: "4821",
  holderName: "Aino Virtanen",
  nickname: "Travel",
  status: "active",
  onlineEnabled: true,
  contactlessEnabled: true,
  monthlyLimit: { amountMinor: 250000, currency: "EUR" },
  transactionLimit: null,
};

/** Visual-regression harness fixture. Not writable by the implementer. */
export default function Fixture() {
  return <CardSettingsPanel card={card} onSaved={() => undefined} />;
}
