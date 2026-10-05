import type { RetrievedContext } from "../retrieve/resolve";
import { type AgentOptions, type AgentRun, jsonObject, runAgent, stringArray } from "./runAgent";

/** A scoped change proposal: what will change, how to tell it worked, and what is explicitly out of scope. */
export interface ChangeProposal {
  summary: string;
  scope: string[];
  acceptance: string[];
  outOfScope: string[];
}

const SYSTEM = [
  "You are the intent agent for a corporate expense management front end.",
  "Turn a product change request into a scoped proposal. Do not write code.",
  'Answer with JSON only: {"summary": string, "scope": [file paths], "acceptance": [testable criteria], "outOfScope": [things not to change]}',
].join("\n");

/** Parses intent-agent JSON into a proposal. Throws on malformed JSON. */
export function parseProposal(raw: string): ChangeProposal {
  const value = jsonObject(raw);
  const summary = Reflect.get(value, "summary");
  return {
    summary: typeof summary === "string" ? summary : "",
    scope: stringArray(Reflect.get(value, "scope")),
    acceptance: stringArray(Reflect.get(value, "acceptance")),
    outOfScope: stringArray(Reflect.get(value, "outOfScope")),
  };
}

/**
 * Intent agent. Sees the request plus component names and owners only (no source), so its calls are "internal"
 * data and may use a commercial tier when one is configured and reachable.
 */
export function proposeChange(
  requestId: string,
  request: string,
  context: RetrievedContext,
  options: AgentOptions,
): Promise<AgentRun<ChangeProposal>> {
  return runAgent({
    agent: "intent",
    requestId,
    task: "intent",
    dataClass: "internal",
    options,
    parse: parseProposal,
    maxTokens: INTENT_MAX_TOKENS,
    messages: () => intentMessages(request, context),
  });
}

/** Output cap for the intent agent. */
export const INTENT_MAX_TOKENS = 1200;

/** Prompt for the intent agent: request, target, nearby components, endpoints and owner. No source code. */
export function intentMessages(request: string, context: RetrievedContext): { system: string; user: string } {
  return {
    system: SYSTEM,
    user: [
      `REQUEST: ${request}`,
      `TARGET: ${context.target ? `${context.target.name} (${context.target.sourceFile})` : "unknown"}`,
      `NEARBY COMPONENTS: ${context.components.map((node) => node.name).join(", ")}`,
      `ENDPOINTS AVAILABLE: ${context.contracts.map((node) => node.name).join(", ") || "none"}`,
      `OWNER: ${context.owners.map((node) => node.name).join(", ") || "unknown"}`,
    ].join("\n"),
  };
}
