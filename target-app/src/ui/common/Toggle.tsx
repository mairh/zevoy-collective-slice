import { colors } from "./tokens";

export interface ToggleProps {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/** Accessible on/off switch. */
export function Toggle({ id, checked, onChange }: ToggleProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        width: 40,
        height: 22,
        borderRadius: 11,
        border: "none",
        background: checked ? colors.accent : colors.line,
        position: "relative",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: checked ? 21 : 3,
          width: 16,
          height: 16,
          borderRadius: 8,
          background: colors.surface,
        }}
      />
    </button>
  );
}
