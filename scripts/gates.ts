/**
 * Runs the four gates and the risk classifier on any diff, without the agent. Use it to try the control plane on
 * a patch of your own.
 *
 *   pnpm gates R3                         a recording in fixtures/recorded
 *   pnpm gates contract-wrong-method      a fixture in fixtures/diffs
 *   pnpm gates ./my-change.patch          any unified diff against target-app/
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadContract } from "../src/analysis/openapi";
import { loadProject } from "../src/analysis/project";
import { loadConfig, OPENAPI_PATH, REPO_ROOT, TARGET_ROOT } from "../src/config";
import { runGates } from "../src/gates";
import { buildGraph } from "../src/ingest/graph";
import { parseRepo } from "../src/ingest/parse";
import { InMemoryGraphStore } from "../src/stores/graph";
import { parseChangeSet } from "../src/workspace/changeSet";

function patchPath(argument: string): string {
  if (argument.endsWith(".patch") && existsSync(argument)) {
    return resolve(argument);
  }
  const folder = /^R\d+$/.test(argument) ? "recorded" : "diffs";
  return join(REPO_ROOT, "fixtures", folder, `${argument}.patch`);
}

const config = loadConfig();
const contract = loadContract(OPENAPI_PATH);
const graph = new InMemoryGraphStore();
await buildGraph(graph, {
  root: TARGET_ROOT,
  modules: parseRepo(loadProject(TARGET_ROOT), TARGET_ROOT, config.risk),
  contract,
  risk: config.risk,
});

for (const argument of process.argv.slice(2)) {
  const changeSet = parseChangeSet(argument, readFileSync(patchPath(argument), "utf8"), TARGET_ROOT);
  const run = await runGates(changeSet, { root: TARGET_ROOT, config, contract, graph });
  console.log(`== ${argument}: ${changeSet.linesChanged} lines, verdict ${run.verdict}, tier ${run.risk.tier}`);
  for (const result of run.results) {
    console.log(`  ${result.gate.padEnd(18)} ${result.status.toUpperCase().padEnd(5)} ${result.summary}`);
    for (const reason of result.reasons) {
      console.log(`      ${reason}`);
    }
  }
  for (const signal of run.risk.signals) {
    console.log(`  [${signal.tier}] ${signal.rule}: ${signal.message}`);
  }
  if (run.risk.approvers.length > 0) {
    console.log(`  approvers: ${run.risk.approvers.map((approver) => approver.handle).join(", ")}`);
  }
}
