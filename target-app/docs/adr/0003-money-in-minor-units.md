---
title: ADR 0003 - Money is carried in minor units
kind: adr
date: 2025-11-03
sensitivity: internal
---
# ADR 0003 - Money is carried in minor units

## Status

Accepted. Owner: @helmi.aalto (ledger). Reviewed by @aino.virtanen and @joonas.koski.

## Context

Card limits, expenses and ledger entries all carry amounts. Early screens passed euro amounts around as
JavaScript numbers (`25.5`), which cannot represent most cent values exactly and drifted when summed.

## Decision

- Every amount is a `Money` object: `{ amountMinor: integer, currency: "EUR" }`, matching the contract schema.
- Amounts are converted to a display string only at the edge, with `formatMoney`, usually through the shared
  Money component. No component divides by 100 itself.
- User input is parsed with `toMinorUnits` and edited with `fromMinorUnits`. Never `parseFloat` an amount.
- Arithmetic on amounts (sums, running balances) happens on integers, as in `runningBalance`.

## Consequences

- Rendering an amount without `formatMoney` is a review finding, and the risk classifier treats components that
  render money as financial.
- A change to how a limit is displayed needs a reviewer from the owning team and the ledger team.
