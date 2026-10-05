import { CardEmptyState } from "./CardEmptyState";

/** Visual-regression harness fixture. Not writable by the implementer. */
export default function Fixture() {
  return <CardEmptyState onRequestCard={() => undefined} />;
}
