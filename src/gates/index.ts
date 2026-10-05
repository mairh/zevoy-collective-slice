import type { Contract } from "../analysis/openapi";
import { loadProjectPair } from "../analysis/project";
import type { SliceConfig } from "../config";
import type { GraphStore } from "../stores/graph";
import type { ChangeSet } from "../workspace/changeSet";
import { apiContractGate } from "./apiContract";
import { astValidationGate } from "./astValidation";
import { classifyRisk, type RiskAssessment } from "./riskTier";
import type { GateContext, GateResult } from "./types";
import { visualRegressionGate } from "./visualRegression";
import { writeScopeGate } from "./writeScope";

export type Verdict = "AUTONOMOUS" | "HUMAN_REVIEW" | "NAMED_APPROVAL" | "BLOCKED";

export interface GateRun {
  results: GateResult[];
  risk: RiskAssessment;
  verdict: Verdict;
}

export interface GateEnvironment {
  root: string;
  config: SliceConfig;
  contract: Contract;
  graph: GraphStore;
  baselineDir?: string;
  /** Called as each gate finishes, so a CLI can stream results. */
  onResult?: (result: GateResult) => void;
}

/**
 * Runs the four gates in order and classifies risk. All deterministic. The verdict is the only output that matters:
 * any FAIL blocks; a SKIP or MEDIUM needs a human; HIGH needs a named owner; only LOW with four PASSes is autonomous.
 */
export async function runGates(changeSet: ChangeSet, env: GateEnvironment): Promise<GateRun> {
  const projects = loadProjectPair(env.root, changeSet);
  const ctx: GateContext = {
    root: env.root,
    changeSet,
    projects,
    config: env.config,
    contract: env.contract,
    graph: env.graph,
  };
  const results: GateResult[] = [];
  const record = (result: GateResult) => {
    results.push(result);
    env.onResult?.(result);
  };
  record(writeScopeGate(changeSet, env.config.allowlist));
  record(astValidationGate(ctx));
  record(apiContractGate(ctx));
  const priorFailure = results.some((result) => result.status === "fail");
  record(await visualRegressionGate(ctx, { priorFailure, baselineDir: env.baselineDir }));
  const risk = await classifyRisk(ctx);

  let verdict: Verdict;
  if (results.some((result) => result.status === "fail")) {
    verdict = "BLOCKED";
  } else if (risk.tier === "HIGH") {
    verdict = "NAMED_APPROVAL";
  } else if (risk.tier === "MEDIUM" || results.some((result) => result.status === "skip")) {
    verdict = "HUMAN_REVIEW";
  } else {
    verdict = "AUTONOMOUS";
  }
  return { results, risk, verdict };
}
