---
title: INC-2026-08-02 - Card UI called an unsanctioned balance endpoint
kind: incident
date: 2026-08-02
sensitivity: internal
---
# INC-2026-08-02 - Card UI called an unsanctioned balance endpoint

## Summary

A change to the cards page added an "available balance" line by calling `GET /balance`, an unversioned
endpoint that a ledger prototype still answered. It returned company-wide balances, not card balances, and
it was never in the contract. Owner: @helmi.aalto, cards impact: @aino.virtanen.

## Root cause

The author assumed a balance must be fetchable because `runningBalance` exists in the ledger code. It is a
client-side helper over ledger entries, not an API.

## What we learned

- Balances are only available through the ledger service. They are NOT exposed to the card UI.
- `GET /balance` is not an API. Anything not in the OpenAPI contract is not an API (ADR 0007).
- Balance figures are financial data. Showing one in a card view needs ledger and cards sign-off.

## Follow-ups

- The api-contract gate now blocks calls to paths outside the contract.
- If the card UI ever needs a balance, the ledger team adds a card-scoped endpoint to the contract first,
  marked `x-sensitivity: financial`, and the card UI consumes it only through `src/api/`.
