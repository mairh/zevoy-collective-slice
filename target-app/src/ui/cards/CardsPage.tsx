import { useEffect, useState } from "react";
import { listCards } from "../../api/cards";
import { usePermission } from "../../auth/usePermission";
import { TransactionList } from "../../transactions/TransactionList";
import type { Card } from "../../types/card";
import { CardEmptyState } from "./CardEmptyState";
import { CardList } from "./CardList";
import { CardSettingsPanel } from "./CardSettingsPanel";

/** Cards page: list, settings for the selected card, and its transactions. */
export function CardsPage() {
  const [cards, setCards] = useState<Card[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const canManage = usePermission("cards:manage");

  useEffect(() => {
    listCards().then((loaded) => {
      setCards(loaded);
      setSelectedId(loaded[0]?.id ?? null);
    });
  }, []);

  const selected = cards.find((card) => card.id === selectedId) ?? null;
  if (cards.length === 0) {
    return <CardEmptyState onRequestCard={() => window.location.assign("/cards/request")} />;
  }
  return (
    <div>
      <CardList cards={cards} selectedId={selectedId} onSelect={setSelectedId} />
      {selected && canManage ? (
        <CardSettingsPanel
          card={selected}
          onSaved={(updated) => setCards((all) => all.map((card) => (card.id === updated.id ? updated : card)))}
        />
      ) : null}
      {selected ? <TransactionList cardId={selected.id} /> : null}
    </div>
  );
}
