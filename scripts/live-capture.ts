/** Runs the live implementer for the given request ids and writes each diff to a directory, without touching recordings. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ChangeRequest, implement } from "../src/agent/implementer";
import { quietExperimentalSqlite } from "../src/cli/warnings";
import { loadConfig, OPENAPI_PATH, REPO_ROOT, TARGET_ROOT } from "../src/config";
import { ingest } from "../src/ingest";
import { resolveContext } from "../src/retrieve/resolve";

quietExperimentalSqlite();
const [outDir = join(REPO_ROOT, ".zevoy", "live"), ...ids] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const config = loadConfig();
const index = await ingest({ root: TARGET_ROOT, config, contractPath: OPENAPI_PATH });
const contract = index.contract;
if (!contract) {
  throw new Error("contract missing");
}
const requests = (
  JSON.parse(readFileSync(join(REPO_ROOT, "fixtures", "change-requests.json"), "utf8")) as { requests: ChangeRequest[] }
).requests;
for (const request of requests.filter((candidate) => ids.length === 0 || ids.includes(candidate.id))) {
  const context = await resolveContext(request.request, {
    root: TARGET_ROOT,
    graph: index.graph,
    vectors: index.vectors,
    embedder: index.embedder,
    config,
  });
  const result = await implement(request, context, { mode: "live", root: TARGET_ROOT, contract });
  writeFileSync(join(outDir, `${request.id}.patch`), result.changeSet.patch);
  console.log(`${request.id}: ${result.changeSet.linesChanged} lines · ${result.summary}`);
}
