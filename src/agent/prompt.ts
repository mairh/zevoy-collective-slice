import { type Contract, deref, type JsonSchema, schemaName } from "../analysis/openapi";
import type { RetrievedContext } from "../retrieve/resolve";

/** Bumped whenever the template changes, and stored with every recorded run. */
export const PROMPT_VERSION = "implementer.v2";

export interface PromptMessages {
  system: string;
  user: string;
}

function describeSchema(contract: Contract, schema: JsonSchema | undefined): string {
  const resolved = deref(contract, schema);
  if (!resolved?.properties) {
    return schema ? schemaName(schema) : "none";
  }
  const fields = Object.entries(resolved.properties).map(([name, property]) => {
    const inner = deref(contract, property);
    const type = property.$ref || property.allOf ? schemaName(property) : (inner?.type ?? "unknown");
    return `${name}: ${type}${inner?.nullable ? " | null" : ""}`;
  });
  return `${schemaName(schema)} { ${fields.join(", ")} }`;
}

const SYSTEM = [
  "You are the implementer agent for a corporate expense management front end (React 19, TypeScript strict).",
  "You receive one change request and graph-resolved context. You return the complete new contents of every file you change.",
  "",
  "Rules. These are also enforced by deterministic gates after you answer; breaking one discards your work:",
  "- Only write files under src/ui/. Never touch ledger, transactions, auth, fixtures or tests.",
  "- Network access goes through the existing functions in src/api/. Never call fetch, axios or XMLHttpRequest directly.",
  "- Only use endpoints listed under CONTRACTS. If the data you need has no endpoint, say so in summary and change nothing.",
  "- No new npm dependencies, no eval, no dangerouslySetInnerHTML, no eslint-disable or @ts-ignore, no process.env.",
  '- Money is { amountMinor: number; currency: "EUR" } in minor units. Never use floats for money.',
  "",
  'Answer with JSON only: {"summary": string, "files": [{"path": string, "content": string}]}',
  "Paths are relative to the repo root, for example src/ui/cards/CardSettingsPanel.tsx.",
].join("\n");

/** Builds the implementer prompt from a request and its graph-resolved context. */
export function buildImplementerPrompt(
  request: string,
  context: RetrievedContext,
  contract: Contract,
  acceptance: string[] = [],
): PromptMessages {
  const contracts = context.contracts.map((node) => {
    const [method, path] = node.name.split(" ");
    const operation = contract.operations.find((candidate) => candidate.method === method && candidate.path === path);
    return operation
      ? `- ${node.name} (${operation.operationId}) body: ${describeSchema(contract, operation.requestSchema)} returns: ${describeSchema(contract, operation.responseSchema)}`
      : `- ${node.name}`;
  });
  const files = context.files.map((file) =>
    [
      `--- ${file.path} (${file.mode === "full" ? "full source, editable" : "exported signatures only"})`,
      file.content,
    ].join("\n"),
  );
  const user = [
    `CHANGE REQUEST: ${request}`,
    ...(acceptance.length > 0 ? ["ACCEPTANCE CRITERIA:", ...acceptance.map((criterion) => `- ${criterion}`)] : []),
    "",
    `TARGET COMPONENT: ${context.target ? `${context.target.name} in ${context.target.sourceFile}` : "none found"}`,
    `OWNER: ${context.owners.map((owner) => owner.name).join(", ") || "unknown"}`,
    "",
    "CONTRACTS (the only endpoints that exist for this area):",
    ...(contracts.length > 0 ? contracts : ["- none"]),
    "",
    "API FUNCTIONS YOU MAY CALL:",
    ...context.functions.map((fn) => `- ${fn.name} (${fn.sourceFile})`),
    "",
    "HISTORY (incidents and know-how that mention the target; do not repeat these mistakes):",
    ...(context.history.length > 0 ? context.history : ["- none"]),
    "",
    "FILES:",
    ...files,
  ].join("\n");
  return { system: SYSTEM, user };
}
