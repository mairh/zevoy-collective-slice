import { resolve } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { loadConfig, OPENAPI_PATH, TARGET_ROOT } from "../config";
import { ingest } from "../ingest";
import { quietExperimentalSqlite } from "./warnings";

quietExperimentalSqlite();

const program = new Command()
  .name("ingest")
  .description("Parse a TypeScript/React repo into the code graph and vector index")
  .option("--repo <path>", "repo root to ingest", TARGET_ROOT)
  .option("--contract <path>", "OpenAPI contract to attach (defaults to the fixture contract for the bundled target)")
  .option("--embedder <kind>", "auto | ollama | hash", "auto")
  .parse();

const options = program.opts<{ repo: string; contract?: string; embedder: "auto" | "ollama" | "hash" }>();
const root = resolve(options.repo);
const contractPath = options.contract ?? (root === TARGET_ROOT ? OPENAPI_PATH : undefined);

const result = await ingest({ root, config: loadConfig(), contractPath, embedder: options.embedder });
const { stats } = result;
console.log(pc.bold(`Ingested ${root} @ ${result.commitSha}`));
console.log(`  files     ${result.modules.length}`);
console.log(
  `  nodes     ${stats.totalNodes}  (${Object.entries(stats.nodes)
    .map(([label, count]) => `${label} ${count}`)
    .join(", ")})`,
);
console.log(
  `  edges     ${stats.totalEdges}  (${Object.entries(stats.edges)
    .map(([type, count]) => `${type} ${count}`)
    .join(", ")})`,
);
console.log(`  chunks    ${result.chunks.length} (symbol-bounded)`);
console.log(`  embedder  ${result.embedder.name}`);
console.log(`  vectors   ${await result.vectors.count()} in ${result.vectors.backend}`);
console.log(`  took      ${result.durationMs} ms`);
