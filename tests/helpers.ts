import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Contract, loadContract } from "../src/analysis/openapi";
import { loadProject, loadProjectPair } from "../src/analysis/project";
import { loadConfig, OPENAPI_PATH, REPO_ROOT, type SliceConfig, TARGET_ROOT } from "../src/config";
import type { GateContext } from "../src/gates/types";
import { buildGraph } from "../src/ingest/graph";
import { parseRepo } from "../src/ingest/parse";
import { InMemoryGraphStore } from "../src/stores/graph";
import { type ChangeSet, parseChangeSet } from "../src/workspace/changeSet";

export interface TestEnv {
  config: SliceConfig;
  contract: Contract;
  graph: InMemoryGraphStore;
}

let cached: TestEnv | undefined;

/** Builds the graph for the bundled target app once per test file. */
export async function testEnv(): Promise<TestEnv> {
  if (cached) {
    return cached;
  }
  const config = loadConfig();
  const contract = loadContract(OPENAPI_PATH);
  const graph = new InMemoryGraphStore();
  const modules = parseRepo(loadProject(TARGET_ROOT), TARGET_ROOT, config.risk);
  await buildGraph(graph, { root: TARGET_ROOT, modules, contract, risk: config.risk });
  cached = { config, contract, graph };
  return cached;
}

/** Loads a committed fixture diff: `R1`-`R3` from fixtures/recorded, anything else from fixtures/diffs. */
export function fixtureChangeSet(name: string): ChangeSet {
  const folder = /^R\d$/.test(name) ? "recorded" : "diffs";
  const patch = readFileSync(join(REPO_ROOT, "fixtures", folder, `${name}.patch`), "utf8");
  return parseChangeSet(name, patch, TARGET_ROOT);
}

/** Gate context for a fixture diff. */
export async function fixtureContext(name: string): Promise<GateContext> {
  const env = await testEnv();
  const changeSet = fixtureChangeSet(name);
  return {
    root: TARGET_ROOT,
    changeSet,
    projects: loadProjectPair(TARGET_ROOT, changeSet),
    config: env.config,
    contract: env.contract,
    graph: env.graph,
  };
}
