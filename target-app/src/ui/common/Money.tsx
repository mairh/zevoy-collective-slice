import { formatMoney } from "../../lib/money";
import type { Money as MoneyValue } from "../../types/money";
import { colors } from "./tokens";

export interface MoneyProps {
  amount: MoneyValue;
  id?: string;
}

/** Renders a monetary amount. Any component that renders this is money-rendering. */
export function Money({ amount, id }: MoneyProps) {
  return (
    <span id={id} style={{ fontVariantNumeric: "tabular-nums", fontSize: 14, color: colors.ink }}>
      {formatMoney(amount)}
    </span>
  );
}
