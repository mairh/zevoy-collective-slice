import type { Card } from "../../types/card";
import { Money } from "../common/Money";
import { colors, text } from "../common/tokens";

export interface CardListItemProps {
  card: Card;
  selected: boolean;
  onSelect: (cardId: string) => void;
}

/** One row in the card list with its monthly limit. */
export function CardListItem({ card, selected, onSelect }: CardListItemProps) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(card.id)}
        style={{ border: `1px solid ${selected ? colors.accent : colors.line}`, background: colors.surface }}
      >
        <span style={text.body}>{card.nickname || `•••• ${card.last4}`}</span>
        <Money amount={card.monthlyLimit} />
      </button>
    </li>
  );
}
