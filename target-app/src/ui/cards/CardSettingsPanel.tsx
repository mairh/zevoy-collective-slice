import { type FormEvent, useState } from "react";
import { updateCardSettings } from "../../api/cards";
import type { Card } from "../../types/card";
import { Button } from "../common/Button";
import { Field } from "../common/Field";
import { Money } from "../common/Money";
import { Panel } from "../common/Panel";
import { TextInput } from "../common/TextInput";
import { Toggle } from "../common/Toggle";
import { colors } from "../common/tokens";
import { FreezeCardToggle } from "./FreezeCardToggle";

export interface CardSettingsPanelProps {
  card: Card;
  onSaved: (card: Card) => void;
}

/** Cardholder settings for one company card. */
export function CardSettingsPanel({ card, onSaved }: CardSettingsPanelProps) {
  const [nickname, setNickname] = useState(card.nickname);
  const [onlineEnabled, setOnlineEnabled] = useState(card.onlineEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const updated = await updateCardSettings(card.id, { nickname, onlineEnabled });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save card settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel title="Card settings" subtitle={`${card.holderName} •••• ${card.last4}`}>
      <form onSubmit={handleSubmit}>
        <Field label="Card nickname" htmlFor="card-nickname">
          <TextInput id="card-nickname" value={nickname} onChange={setNickname} />
        </Field>
        <Field label="Online payments" htmlFor="card-online">
          <Toggle id="card-online" checked={onlineEnabled} onChange={setOnlineEnabled} />
        </Field>
        <Field label="Monthly limit" htmlFor="card-monthly-limit" hint="Set by your company admin.">
          <Money id="card-monthly-limit" amount={card.monthlyLimit} />
        </Field>
        <FreezeCardToggle cardId={card.id} frozen={card.status === "frozen"} />
        {error ? (
          <p role="alert" style={{ color: colors.danger, fontSize: 13 }}>
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </form>
    </Panel>
  );
}
