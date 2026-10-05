/** Monetary amount in minor units (cents). Never a float. */
export interface Money {
  amountMinor: number;
  currency: "EUR";
}
