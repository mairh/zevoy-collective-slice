import type { ReactNode } from "react";
import { colors } from "./tokens";

export interface ButtonProps {
  children: ReactNode;
  type?: "button" | "submit";
  disabled?: boolean;
  variant?: "primary" | "secondary";
  onClick?: () => void;
}

/** Primary and secondary actions. */
export function Button({ children, type = "button", disabled = false, variant = "primary", onClick }: ButtonProps) {
  const primary = variant === "primary";
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      style={{
        padding: "8px 14px",
        fontSize: 14,
        fontWeight: 600,
        borderRadius: 6,
        border: `1px solid ${primary ? colors.accent : colors.line}`,
        background: primary ? colors.accent : colors.surface,
        color: primary ? colors.surface : colors.ink,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}
