---
title: Know-how interview - cards UI with Aino Virtanen
kind: know-how
date: 2026-09-10
sensitivity: internal
---
# Know-how interview - cards UI with Aino Virtanen

Structured interview with @aino.virtanen, owner of `src/ui/cards/`. Interviewer: @sara.niemi.

## Q: What is the most fragile part of the cards UI?

A: CardSettingsPanel. It shows limits and writes settings with `updateCardSettings`
(`PATCH /cards/{id}`). Both money rendering and the request body are easy to get subtly wrong.

## Q: What should someone check before changing how a limit is displayed?

A: That every amount still goes through `formatMoney`. Read INC-2026-06-14 first. Re-run the visual
baselines; a one-cent difference is a real bug, not noise.

## Q: Which fields can the card UI send?

A: Only what `CardSettingsUpdate` allows: nickname, online and contactless toggles, and today
`transactionLimit`. Platform has said `transactionLimit` will move to its own limits endpoint, so do not
build new UI on it.

## Q: Anything people get wrong about freezing cards?

A: FreezeCardToggle must call `freezeCard` / `unfreezeCard`, never `updateCardSettings` with a status
field. Status is not in the update schema.

## Q: Who else should review card changes?

A: Ledger (@helmi.aalto) for anything showing balances, and @joonas.koski for anything touching `src/api/`.
