---
title: INC-2026-06-14 - Card monthly limit shown one cent low
kind: incident
date: 2026-06-14
sensitivity: internal
---
# INC-2026-06-14 - Card monthly limit shown one cent low

## Summary

For about four hours, CardSettingsPanel showed some monthly limits one cent lower than the limit stored on the
card (2 500,00 EUR rendered as 2 499,99 EUR). No limit was changed on the back end. Owner: @aino.virtanen.

## Timeline

- 09:10 Release with a redesigned limit row in CardSettingsPanel.
- 11:40 Support ticket: "my limit went down by a cent".
- 13:05 Rollback. 13:30 root cause confirmed.

## Root cause

The new limit row converted `monthlyLimit.amountMinor` to a float euro value, applied a percentage for the
"used this month" bar, then truncated with `Math.floor` before formatting. The display path bypassed
`formatMoney`, so the float error reached the screen.

## What broke last time this changed

- The same row also builds the `PATCH /cards/{id}` body. The draft change sent the truncated float back as
  `transactionLimit`, which the contract rejects (`amountMinor` must be an integer). The api-contract gate
  caught it before merge.

## Follow-ups

- Render every amount in CardSettingsPanel through the Money component / `formatMoney` (ADR 0003).
- Any change to limit rendering needs visual regression baselines and a reviewer from @aino.virtanen.
