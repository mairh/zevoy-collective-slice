/**
 * Back-end state change impact: diffs the current contract against the next back-end release and walks the code
 * graph to show which functions, components and owners each change reaches. Deterministic; no model.
 *
 *   pnpm impact                                   fixtures/openapi.yaml -> fixtures/openapi.next.yaml
 *   pnpm impact --next path/to/next.yaml          any next contract
 */
import { join, relative, resolve } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { loadContract } from "../analysis/openapi";
import { loadProject } from "../analysis/project";
import { loadConfig, OPENAPI_PATH, REPO_ROOT, TARGET_ROOT } from "../config";
import { diffContracts, type Impact, impactOf } from "../impact/drift";
import { buildGraph } from "../ingest/graph";
import { parseRepo } from "../ingest/parse";
import { InMemoryGraphStore } from "../stores/graph";

const program = new Command()
  .name("impact")
  .description("Diff the back-end contract against its next release and trace the impact through the code graph")
  .option("--current <path>", "contract the code is built against", OPENAPI_PATH)
  .option("--next <path>", "contract of the next back-end release", join(REPO_ROOT, "fixtures", "openapi.next.yaml"))
  .parse();

const options = program.opts<{ current: string; next: string }>();
const config = loadConfig();
const before = loadContract(resolve(options.current));
const after = loadContract(resolve(options.next));
const graph = new InMemoryGraphStore();
await buildGraph(graph, {
  root: TARGET_ROOT,
  modules: parseRepo(loadProject(TARGET_ROOT), TARGET_ROOT, config.risk),
  contract: before,
  risk: config.risk,
});

const changes = diffContracts(before, after);
const impacts = await impactOf(changes, graph);

const names = (list: { name: string }[]) =>
  list.length > 0 ? list.map((node) => node.name).join(", ") : pc.dim("none");

function printImpact(impact: Impact): void {
  const { change } = impact;
  const tag = change.breaking ? pc.red("BREAKING") : pc.green("additive");
  console.log(`\n${tag} ${pc.bold(change.description)}`);
  console.log(`  functions    ${names(impact.functions)}`);
  console.log(`  components   ${names(impact.components)}`);
  console.log(`  rendered by  ${names(impact.renderedBy)}`);
  console.log(`  owners       ${impact.owners.length > 0 ? impact.owners.join(", ") : pc.dim("none")}`);
  console.log(
    `  change req   ${impact.changeRequest ? pc.cyan(impact.changeRequest) : pc.dim("none: no current consumer")}`,
  );
}

console.log(
  pc.bold(`Contract drift ${relative(REPO_ROOT, before.sourceFile)} -> ${relative(REPO_ROOT, after.sourceFile)}`),
);
console.log(`  ${changes.length} changes, ${changes.filter((change) => change.breaking).length} breaking`);
console.log(pc.dim("  Reach is endpoint-level: every caller of a changed operation, not proof the property is used."));
for (const impact of impacts) {
  printImpact(impact);
}
