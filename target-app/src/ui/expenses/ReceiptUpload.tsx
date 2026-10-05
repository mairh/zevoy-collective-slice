import { useState } from "react";
import { uploadReceipt } from "../../api/receipts";
import { Button } from "../common/Button";

/** Attaches a receipt photo to an expense. */
export function ReceiptUpload({ expenseId }: { expenseId: string }) {
  const [status, setStatus] = useState<"idle" | "uploading" | "done">("idle");
  async function handleFile(file: File) {
    setStatus("uploading");
    const buffer = await file.arrayBuffer();
    const imageBase64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    await uploadReceipt(expenseId, imageBase64);
    setStatus("done");
  }
  return (
    <div>
      <input
        type="file"
        accept="image/*"
        onChange={(event) => event.target.files?.[0] && handleFile(event.target.files[0])}
      />
      <Button variant="secondary" disabled={status === "uploading"}>
        {status === "done" ? "Receipt attached" : "Attach receipt"}
      </Button>
    </div>
  );
}
