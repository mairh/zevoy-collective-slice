import type { Money } from "../types/money";

const formatter = new Intl.NumberFormat("fi-FI", { style: "currency", currency: "EUR" });

/** Formats a minor-unit amount for display. */
export function formatMoney(money: Money): string {
  return formatter.format(money.amountMinor / 100);
}

/** Parses user input like "12,50" into minor units. Returns null when the input is not a valid amount. */
export function toMinorUnits(input: string): number | null {
  const normalised = input.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalised)) {
    return null;
  }
  return Math.round(Number(normalised) * 100);
}

/** Converts minor units to an editable decimal string. */
export function fromMinorUnits(amountMinor: number): string {
  return (amountMinor / 100).toFixed(2).replace(".", ",");
}
