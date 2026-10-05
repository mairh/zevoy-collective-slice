import type { CSSProperties } from "react";

export const colors = {
  ink: "#1d2330",
  muted: "#5b6476",
  line: "#d9dde5",
  surface: "#ffffff",
  accent: "#2f5bea",
  danger: "#c0392b",
};

export const text: Record<"title" | "subtitle" | "body" | "muted" | "label", CSSProperties> = {
  title: { margin: 0, fontSize: 18, fontWeight: 600, color: colors.ink },
  subtitle: { margin: "2px 0 0", fontSize: 13, color: colors.muted },
  body: { margin: "0 0 12px", fontSize: 14, lineHeight: 1.5, color: colors.ink },
  muted: { margin: "0 0 12px", fontSize: 13, lineHeight: 1.5, color: colors.muted },
  label: { display: "block", marginBottom: 4, fontSize: 13, fontWeight: 600, color: colors.ink },
};
