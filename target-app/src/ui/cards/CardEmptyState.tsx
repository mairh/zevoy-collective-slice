import { Button } from "../common/Button";
import { Panel } from "../common/Panel";
import { text } from "../common/tokens";

export interface CardEmptyStateProps {
  onRequestCard: () => void;
}

/** Shown on the cards page when the user has no cards. */
export function CardEmptyState({ onRequestCard }: CardEmptyStateProps) {
  return (
    <Panel title="No cards yet">
      <p style={text.body}>You don't have any company cards.</p>
      <Button onClick={onRequestCard}>Request a card</Button>
    </Panel>
  );
}
