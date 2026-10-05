import { useState } from "react";
import { freezeCard, unfreezeCard } from "../../api/cards";
import { Field } from "../common/Field";
import { Toggle } from "../common/Toggle";

export interface FreezeCardToggleProps {
  cardId: string;
  frozen: boolean;
}

/** Freezes or unfreezes a card immediately, outside the settings form submit. */
export function FreezeCardToggle({ cardId, frozen }: FreezeCardToggleProps) {
  const [isFrozen, setIsFrozen] = useState(frozen);
  async function handleChange(next: boolean) {
    const card = next ? await freezeCard(cardId) : await unfreezeCard(cardId);
    setIsFrozen(card.status === "frozen");
  }
  return (
    <Field label="Freeze card" htmlFor="card-frozen" hint="Frozen cards decline all new payments.">
      <Toggle id="card-frozen" checked={isFrozen} onChange={handleChange} />
    </Field>
  );
}
