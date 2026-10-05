import { colors } from "./tokens";

export interface TextInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  inputMode?: "text" | "decimal";
  placeholder?: string;
}

/** Single-line text input. */
export function TextInput({ id, value, onChange, inputMode = "text", placeholder }: TextInputProps) {
  return (
    <input
      id={id}
      name={id}
      value={value}
      inputMode={inputMode}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      style={{
        boxSizing: "border-box",
        width: "100%",
        padding: "7px 10px",
        fontSize: 14,
        border: `1px solid ${colors.line}`,
        borderRadius: 6,
      }}
    />
  );
}
