import { apiClient } from "./client";

export interface ReceiptUploadResult {
  receiptId: string;
  pages: number;
}

/** Uploads a receipt image as base64 and returns its id. */
export function uploadReceipt(expenseId: string, imageBase64: string): Promise<ReceiptUploadResult> {
  return apiClient.post<ReceiptUploadResult>(`/expenses/${expenseId}/receipt`, { imageBase64 });
}
