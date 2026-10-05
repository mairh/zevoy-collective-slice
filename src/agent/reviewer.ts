import type { Verdict } from "../gates";
import type { ChangeProposal } from "./intent";
import { type AgentOptions, type AgentRun, jsonObject, runAgent } from "./runAgent";

export interface Objection {
  severity: "high" | "low";
  message: string;
}

export interface Review {
  objections: Objection[];
}

const SYSTEM = [
  "You are an adversarial code reviewer for a fintech front end. Your only job is to find reasons this diff is wrong.",
  "Rules for objections:",
  "- Every objection must point at a specific added or removed line in the DIFF and say what goes wrong at runtime.",
  '- "high" is only for: a real bug, wrong money handling (amounts must be integer minor units), a security or',
  "  data-exposure issue, or broken accessibility of a control. Wording, tone, style preferences and speculation are",
  '  "low" at most.',
  "- Do not invent requirements. Judge the diff against the change request, not against criteria you imagine.",
  "- If you find nothing concrete, return an empty list. An empty list is a good outcome.",
  'Answer with JSON only: {"objections": [{"severity": "high" | "low", "message": string}]}',
].join("\n");

function parse(raw: string): Review {
  const value = jsonObject(raw);
  const list = Reflect.get(value, "objections");
  const objections: Objection[] = [];
  for (const item of Array.isArray(list) ? list : []) {
    const message: unknown = typeof item === "object" && item !== null ? Reflect.get(item, "message") : undefined;
    const severity: unknown = typeof item === "object" && item !== null ? Reflect.get(item, "severity") : undefined;
    if (typeof message === "string" && message.trim() !== "") {
      objections.push({ severity: severity === "high" ? "high" : "low", message: message.trim() });
    }
  }
  return { objections };
}

/**
 * Adversarial reviewer. Routed to a different model family from the implementer on purpose, because a model
 * reviewing its own output is close to worthless. It reads the diff, so its calls are proprietary-source data.
 */
export function reviewDiff(
  requestId: string,
  request: string,
  patch: string,
  proposal: ChangeProposal,
  options: AgentOptions,
): Promise<AgentRun<Review>> {
  return runAgent({
    agent: "reviewer",
    requestId,
    task: "adversarial-review",
    dataClass: "proprietary-source",
    options,
    parse,
    maxTokens: 900,
    messages: () => ({
      system: SYSTEM,
      user: [
        `CHANGE REQUEST: ${request}`,
        `ACCEPTANCE CRITERIA (from the intent agent; advisory):\n- ${proposal.acceptance.join("\n- ")}`,
        "",
        "DIFF:",
        patch,
      ].join("\n"),
    }),
  });
}

/**
 * Applies a review to the gate verdict. Deterministic, and one-directional: a review can only escalate (a high
 * objection turns AUTONOMOUS into HUMAN_REVIEW). It can never unblock, approve or lower anything.
 */
export function applyReview(verdict: Verdict, review: Review | null): Verdict {
  if (verdict === "AUTONOMOUS" && review?.objections.some((objection) => objection.severity === "high")) {
    return "HUMAN_REVIEW";
  }
  return verdict;
}
