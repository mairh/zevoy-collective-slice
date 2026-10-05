import type { ReactNode } from "react";
import { text } from "./tokens";

export interface FieldProps {
  label: string;
  htmlFor: string;
  hint?: string;
  children: ReactNode;
}

/** Label, control and optional hint, stacked. */
export function Field({ label, htmlFor, hint, children }: FieldProps) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label htmlFor={htmlFor} style={text.label}>
        {label}
      </label>
      {children}
      {hint ? <p style={{ ...text.muted, margin: "4px 0 0" }}>{hint}</p> : null}
    </div>
  );
}
