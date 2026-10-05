import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import type { ChangeRequest } from "../agent/implementer";
import { loadConfig, OPENAPI_PATH, REPO_ROOT, TARGET_ROOT } from "../config";
import { evaluateGolden } from "../eval/golden";
import { type ParityTask, runParity } from "../eval/parity";
import { ingest } from "../ingest";
import { resolveContext } from "../retrieve/resolve";
import { loadRouterConfig, type ModelSpec } from "../router/router";
import { quietExperimentalSqlite } from "./warnings";

quietExperimentalSqlite();

const program = new Command()
  .name("eval")
  .description("Golden-set regression for the control plane, and the parity harness for model tiers")
  .option("--parity <task>", "intent | code-generation: compare two local model tiers on the golden requests")
  .option("--candidate <id>", "cheaper model id from config/router.json", "local-small")
  .option("--baseline <id>", "current model id from config/router.json", "local-coder")
  .parse();
const options = program.opts<{ parity?: ParityTask; candidate: string; baseline: string }>();

const config = loadConfig();
const router = loadRouterConfig();
const index = await ingest({ root: TARGET_ROOT, config, contractPath: OPENAPI_PATH });
const contract = index.contract;
if (!contract) {
  throw new Error("contract missing");
}
const env = { root: TARGET_ROOT, config, contract, graph: index.graph };

if (!options.parity) {
  const results = await evaluateGolden(env);
  for (const result of results) {
    const mark = result.ok ? pc.green("ok  ") : pc.red("FAIL");
    const actual = `${result.actual.verdict} ${result.actual.tier} [${result.actual.failingGates.join(", ")}]`;
    const expected = `${result.expected.verdict} ${result.expected.tier} [${result.expected.failingGates.join(", ")}]`;
    console.log(
      `${mark} ${result.expected.diff.padEnd(50)} ${result.ok ? pc.dim(actual) : `${actual} ${pc.red(`expected ${expected}`)}`}`,
    );
  }
  const passed = results.filter((result) => result.ok).length;
  console.log(pc.bold(`\nGolden set: ${passed}/${results.length} as expected`));
  process.exitCode = passed === results.length ? 0 : 1;
} else {
  const modelOf = (id: string): ModelSpec => {
    const spec = router.models[id];
    if (spec?.provider !== "ollama") {
      throw new Error(`${id} is not a local model in config/router.json`);
    }
    return { id, ...spec };
  };
  const all = (
    JSON.parse(readFileSync(join(REPO_ROOT, "fixtures", "change-requests.json"), "utf8")) as {
      requests: ChangeRequest[];
    }
  ).requests;
  const requests = [];
  for (const request of all) {
    requests.push({
      request,
      context: await resolveContext(request.request, {
        root: TARGET_ROOT,
        graph: index.graph,
        vectors: index.vectors,
        embedder: index.embedder,
        config,
      }),
    });
  }
  const report = await runParity({
    task: options.parity,
    candidate: modelOf(options.candidate),
    baseline: modelOf(options.baseline),
    requests,
    env,
  });
  for (const score of [report.candidate, report.baseline]) {
    console.log(
      pc.bold(
        `${score.model}: ${Math.round(score.successRate * 100)}% success, mean ${(score.meanMs / 1000).toFixed(1)}s`,
      ),
    );
    for (const entry of score.samples) {
      console.log(`  ${entry.ok ? pc.green("ok  ") : pc.red("FAIL")} ${entry.requestId} ${pc.dim(entry.detail)}`);
    }
  }
  console.log(pc.bold(`\n${report.holds ? pc.green(report.recommendation) : pc.yellow(report.recommendation)}`));
}
