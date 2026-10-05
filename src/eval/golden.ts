import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Contract } from "../analysis/openapi";
import { REPO_ROOT, type SliceConfig } from "../config";
import { runGates, type Verdict } from "../gates";
import type { RiskTier } from "../gates/riskTier";
import type { GateName } from "../gates/types";
import type { GraphStore } from "../stores/graph";
import { parseChangeSet } from "../workspace/changeSet";

export interface GoldenCase {
  diff: string;
  verdict: Verdict;
  tier: RiskTier;
  failingGates: GateName[];
}

export interface GoldenResult {
  expected: GoldenCase;
  actual: Omit<GoldenCase, "diff">;
  ok: boolean;
}

/** Loads fixtures/golden.json. */
export function loadGolden(path: string = join(REPO_ROOT, "fixtures", "golden.json")): GoldenCase[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { cases: GoldenCase[] }).cases;
}

/**
 * Runs every golden diff through the control plane and compares verdict, tier and failing gates with the expected
 * outcome. Any prompt, model, rule or agent-graph change must keep this at 100% before it is promoted.
 */
export async function evaluateGolden(env: {
  root: string;
  config: SliceConfig;
  contract: Contract;
  graph: GraphStore;
  cases?: GoldenCase[];
}): Promise<GoldenResult[]> {
  const results: GoldenResult[] = [];
  for (const expected of env.cases ?? loadGolden()) {
    const changeSet = parseChangeSet(expected.diff, readFileSync(join(REPO_ROOT, expected.diff), "utf8"), env.root);
    const run = await runGates(changeSet, {
      root: env.root,
      config: env.config,
      contract: env.contract,
      graph: env.graph,
    });
    const actual = {
      verdict: run.verdict,
      tier: run.risk.tier,
      failingGates: run.results.filter((result) => result.status === "fail").map((result) => result.gate),
    };
    const ok =
      actual.verdict === expected.verdict &&
      actual.tier === expected.tier &&
      actual.failingGates.join(",") === expected.failingGates.join(",");
    results.push({ expected, actual, ok });
  }
  return results;
}
