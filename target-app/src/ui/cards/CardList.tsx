import type { Card } from "../../types/card";
import { CardListItem } from "./CardListItem";

export interface CardListProps {
  cards: Card[];
  selectedId: string | null;
  onSelect: (cardId: string) => void;
}

/** All cards the user can see. */
export function CardList({ cards, selectedId, onSelect }: CardListProps) {
  return (
    <ul style={{ listStyle: "none", padding: 0 }}>
      {cards.map((card) => (
        <CardListItem key={card.id} card={card} selected={card.id === selectedId} onSelect={onSelect} />
      ))}
    </ul>
  );
}
