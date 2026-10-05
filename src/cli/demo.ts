import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Command } from "commander";
import pc from "picocolors";
import { type ChangeRequest, implement } from "../agent/implementer";
import { loadConfig, OPENAPI_PATH, REPO_ROOT, TARGET_ROOT } from "../config";
import { type GateRun, runGates } from "../gates";
import type { GateResult } from "../gates/types";
import { ingest } from "../ingest";
import { resolveContext } from "../retrieve/resolve";
import { quietExperimentalSqlite } from "./warnings";

quietExperimentalSqlite();

const program = new Command()
  .name("demo")
  .description("Run the change requests through retrieval, the implementer and the four gates")
  .option("--live", "generate diffs with a local Ollama model instead of replaying recordings", false)
  .option("--record", "with --live, overwrite fixtures/recorded with the new model output", false)
  .option("--only <ids>", "comma-separated request ids, e.g. R3")
  .option("--embedder <kind>", "auto | ollama | hash", "auto")
  .option("--pace <ms>", "delay between output lines, for screen recording", "0")
  .parse();

const options = program.opts<{
  live: boolean;
  record: boolean;
  only?: string;
  embedder: "auto" | "ollama" | "hash";
  pace: string;
}>();
const pace = Number(options.pace);
const INDENT = "      ";

async function say(line = ""): Promise<void> {
  console.log(line);
  if (pace > 0) {
    await sleep(pace);
  }
}

function gateLine(result: GateResult): string {
  const name = `GATE ${result.gate} `;
  const dots = ".".repeat(Math.max(3, 44 - name.length));
  const status =
    result.status === "pass"
      ? pc.green("PASS")
      : result.status === "fail"
        ? pc.red(pc.bold("FAIL"))
        : pc.yellow("SKIP");
  const summary = result.status === "fail" ? "" : `  ${pc.dim(result.summary)}`;
  return `${INDENT}${name}${pc.dim(dots)} ${status}${summary}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

async function printVerdict(run: GateRun): Promise<void> {
  const tierColour = run.risk.tier === "HIGH" ? pc.red : run.risk.tier === "MEDIUM" ? pc.yellow : pc.green;
  const headline = run.risk.signals[0];
  await say(
    `${INDENT}Risk tier: ${tierColour(pc.bold(run.risk.tier))}${run.verdict === "BLOCKED" && headline ? pc.dim(` (${headline.message})`) : ""}`,
  );
  if (run.verdict !== "BLOCKED") {
    for (const signal of run.risk.signals.slice(0, 5)) {
      await say(`${INDENT}  ${pc.dim("·")} ${signal.message}`);
    }
  }
  await say();
  if (run.verdict === "AUTONOMOUS") {
    await say(
      `${INDENT}${pc.green(pc.bold("ELIGIBLE FOR AUTONOMOUS DEPLOY."))} ${pc.dim("Deploy itself is out of scope for this slice.")}`,
    );
  } else if (run.verdict === "NAMED_APPROVAL") {
    const approvers = run.risk.approvers.map((approver) => `${approver.handle} (${approver.rule})`).join(", ");
    await say(
      `${INDENT}${pc.yellow(pc.bold("HELD FOR NAMED APPROVER:"))} ${approvers || pc.red("no CODEOWNERS entry, cannot proceed until one exists")}`,
    );
    await say(`${INDENT}${pc.dim("Every gate passed. The tier alone requires a human; HIGH is never autonomous.")}`);
  } else if (run.verdict === "HUMAN_REVIEW") {
    await say(
      `${INDENT}${pc.yellow(pc.bold("HELD FOR HUMAN REVIEW."))} ${pc.dim("MEDIUM risk or a gate could not verify.")}`,
    );
  } else {
    await say(`${INDENT}${pc.red(pc.bold("BLOCKED."))} Diff discarded. No human review consumed. No deploy attempted.`);
  }
}

const config = loadConfig();
const all = (
  JSON.parse(readFileSync(join(REPO_ROOT, "fixtures", "change-requests.json"), "utf8")) as { requests: ChangeRequest[] }
).requests;
const only = options.only?.split(",").map((id) => id.trim());
const requests = only ? all.filter((request) => only.includes(request.id)) : all;

await say(pc.bold("Zevoy Collective · working slice"));
await say(pc.dim("One implementer agent behind a deterministic control plane. Gates are code, not model judgement."));
await say();

const index = await ingest({ root: TARGET_ROOT, config, contractPath: OPENAPI_PATH, embedder: options.embedder });
const contract = index.contract;
if (!contract) {
  throw new Error("fixture contract failed to load");
}
await say(
  `Ingest   target-app @ ${index.commitSha} · ${index.modules.length} files → ${index.stats.totalNodes} nodes, ${index.stats.totalEdges} edges · ${index.chunks.length} symbol-bounded chunks · ${index.durationMs} ms`,
);
await say(
  pc.dim(`         graph ${index.graph.backend} · vectors ${index.vectors.backend} · embedder ${index.embedder.name}`),
);
await say(
  pc.dim(
    options.live
      ? `         implementer LIVE via Ollama${options.record ? " (recording to fixtures/recorded)" : ""}`
      : "         implementer REPLAY: recorded diffs from fixtures/recorded (--live regenerates them with Ollama)",
  ),
);

const outcomes: { id: string; run: GateRun }[] = [];
for (const [position, request] of requests.entries()) {
  await say();
  await say(`${pc.bold(`[${position + 1}/${requests.length}]`)} Change request: ${pc.cyan(`"${request.request}"`)}`);
  const context = await resolveContext(request.request, {
    root: TARGET_ROOT,
    graph: index.graph,
    vectors: index.vectors,
    embedder: index.embedder,
    config,
  });
  const nodeCount =
    context.components.length + context.functions.length + context.contracts.length + context.owners.length;
  await say(
    `${INDENT}Retrieved ${nodeCount} context nodes from graph (${plural(context.components.length, "component")}, ${plural(context.functions.length, "function")}, ${plural(context.contracts.length, "contract")}, ${plural(context.owners.length, "owner")})`,
  );
  await say(
    pc.dim(
      `${INDENT}Target ${context.target?.name ?? "none"} · withheld ${plural(context.withheld.length, "financial node")} outside write scope${context.withheld.length > 0 ? `: ${context.withheld.map((node) => node.name).join(", ")}` : ""}`,
    ),
  );

  const result = await implement(request, context, {
    mode: options.live ? "live" : "replay",
    root: TARGET_ROOT,
    contract,
    record: options.record,
  });
  const provenance =
    result.mode === "replay"
      ? `replay · ${result.meta.provenance} · ${result.meta.promptVersion}`
      : `live · ${result.meta.model} · ${result.meta.promptVersion}`;
  await say(
    `${INDENT}Implementer: diff produced, ${plural(result.changeSet.linesChanged, "line")}, ${plural(result.changeSet.files.length, "file")}  ${pc.dim(`[${provenance}]`)}`,
  );
  await say();

  const run = await runGates(result.changeSet, {
    root: TARGET_ROOT,
    config,
    contract,
    graph: index.graph,
  });
  for (const gate of run.results) {
    await say(gateLine(gate));
    if (gate.status !== "pass") {
      for (const reason of gate.reasons.slice(0, 4)) {
        await say(`${INDENT}       ${gate.status === "fail" ? pc.red(reason) : pc.dim(reason)}`);
      }
    }
  }
  await printVerdict(run);
  outcomes.push({ id: request.id, run });
}

await say();
await say(pc.bold("Summary"));
for (const { id, run } of outcomes) {
  const failed = run.results.filter((gate) => gate.status === "fail").length;
  const skipped = run.results.filter((gate) => gate.status === "skip").length;
  const passed = run.results.filter((gate) => gate.status === "pass").length;
  const gates =
    failed > 0 ? `${failed} FAIL${skipped > 0 ? `, ${skipped} SKIP` : ""}` : `${passed}/${run.results.length} PASS`;
  const verdict = {
    AUTONOMOUS: pc.green("autonomous-eligible"),
    NAMED_APPROVAL: pc.yellow(`named approver ${run.risk.approvers.map((approver) => approver.handle).join(", ")}`),
    HUMAN_REVIEW: pc.yellow("human review"),
    BLOCKED: pc.red("blocked before any human saw it"),
  }[run.verdict];
  await say(`  ${id}  ${run.risk.tier.padEnd(6)} ${gates.padEnd(16)} → ${verdict}`);
}
