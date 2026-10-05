import type { ReactNode } from "react";
import { colors, text } from "./tokens";

export interface PanelProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
}

/** Bordered surface with a heading. */
export function Panel({ title, subtitle, children }: PanelProps) {
  return (
    <section
      style={{
        width: 420,
        padding: 20,
        border: `1px solid ${colors.line}`,
        borderRadius: 8,
        background: colors.surface,
        fontFamily: "Helvetica, Arial, sans-serif",
      }}
    >
      <header style={{ marginBottom: 16 }}>
        <h2 style={text.title}>{title}</h2>
        {subtitle ? <p style={text.subtitle}>{subtitle}</p> : null}
      </header>
      {children}
    </section>
  );
}
