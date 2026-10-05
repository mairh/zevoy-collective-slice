---
title: ADR 0007 - All HTTP goes through the API client
kind: adr
date: 2026-01-19
sensitivity: internal
---
# ADR 0007 - All HTTP goes through the API client

## Status

Accepted. Owner: @joonas.koski (platform).

## Context

Components called `fetch` directly with hand-built URLs. Calls skipped auth headers, bypassed the `/api/v1`
base path and could not be checked against the OpenAPI contract.

## Decision

- Components never call `fetch`. They call a typed function in `src/api/` (for example `updateCardSettings`
  or `listTeamMembers`), which calls `apiClient` (`request` in `src/api/client.ts`).
- Every path a client function uses must exist in the contract with the same method. A call to a path that is
  not in the contract fails the api-contract gate.
- The banking client (`createBankingClient`) is only imported from `src/api/payments.ts`.

## Consequences

- Adding a back-end call means adding or reusing a function in `src/api/` and, if the endpoint is new, a
  contract change reviewed by the owning back-end team first.
- Removing an endpoint from the contract shows up as a dead client function and its calling components.
