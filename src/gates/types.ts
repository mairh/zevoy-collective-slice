import type { Contract } from "../analysis/openapi";
import type { ProjectPair } from "../analysis/project";
import type { SliceConfig } from "../config";
import type { GraphStore } from "../stores/graph";
import type { ChangeSet } from "../workspace/changeSet";

export type GateName = "write-scope" | "ast-validation" | "api-contract" | "visual-regression";

export type GateStatus = "pass" | "fail" | "skip";

/** A single, located reason. Precision is the point: rule, file and line, never a vague verdict. */
export interface Finding {
  rule: string;
  file: string;
  line: number | null;
  message: string;
}

export interface GateResult {
  gate: GateName;
  status: GateStatus;
  /** Only true for status "pass". A skipped gate is never a pass. */
  pass: boolean;
  /** One line for the demo output. */
  summary: string;
  reasons: string[];
  findings: Finding[];
}

export interface GateContext {
  root: string;
  changeSet: ChangeSet;
  projects: ProjectPair;
  config: SliceConfig;
  contract: Contract;
  graph: GraphStore;
}

/** Builds a GateResult from findings. Any finding fails the gate. */
export function resultFromFindings(gate: GateName, findings: Finding[], passSummary: string): GateResult {
  const status: GateStatus = findings.length === 0 ? "pass" : "fail";
  return {
    gate,
    status,
    pass: status === "pass",
    summary: status === "pass" ? passSummary : `${findings.length} violation${findings.length === 1 ? "" : "s"}`,
    reasons: findings.map(formatFinding),
    findings,
  };
}

/** Renders a finding as `message  (file:line)`. */
export function formatFinding(finding: Finding): string {
  const location = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
  return `${finding.message}  (${location})`;
}
