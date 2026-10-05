import type { Card, CardSettingsUpdate } from "../types/card";
import { apiClient } from "./client";

/** Lists cards visible to the current user. */
export function listCards(): Promise<Card[]> {
  return apiClient.get<Card[]>("/cards");
}

/** Fetches a single card. */
export function getCard(cardId: string): Promise<Card> {
  return apiClient.get<Card>(`/cards/${cardId}`);
}

/** Updates cardholder-editable settings. */
export function updateCardSettings(cardId: string, settings: CardSettingsUpdate): Promise<Card> {
  return apiClient.patch<Card>(`/cards/${cardId}`, settings);
}

/** Freezes a card immediately. */
export function freezeCard(cardId: string): Promise<Card> {
  return apiClient.post<Card>(`/cards/${cardId}/freeze`, {});
}

/** Unfreezes a previously frozen card. */
export function unfreezeCard(cardId: string): Promise<Card> {
  return apiClient.post<Card>(`/cards/${cardId}/unfreeze`, {});
}
