import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Command } from "commander";
import pc from "picocolors";
import type { ChangeRequest } from "../agent/implementer";
import type { AgentName } from "../agent/runAgent";
import { AuditLog, runEntries, verifyAudit } from "../audit/log";
import { loadConfig, OPENAPI_PATH, REPO_ROOT, STATE_DIR, TARGET_ROOT } from "../config";
import type { GateResult } from "../gates/types";
import { ingest } from "../ingest";
import { CircuitBreaker } from "../release/breaker";
import { loadControl } from "../release/control";
import { egressLog } from "../router/egress";
import { usageByAgent } from "../router/meter";
import { loadRouterConfig } from "../router/router";
import { loadRun, type RouteSummary, type RunState, runSwarm, type Step } from "../swarm/orchestrator";
import { quietExperimentalSqlite } from "./warnings";

quietExperimentalSqlite();

const program = new Command()
  .name("demo")
  .description("Run change requests through the swarm and the deterministic control plane")
  .option("--live", "run the agents against local Ollama models instead of replaying recordings", false)
  .option("--live-agents <names>", "run only these agents live: intent,implementer,reviewer")
  .option("--record", "overwrite fixtures/recorded with the live agents' output", false)
  .option("--only <ids>", "comma-separated request ids, e.g. R3")
  .option("--resume <runId>", "resume a checkpointed run from its last completed step")
  .option("--embedder <kind>", "auto | ollama | hash", "auto")
  .option("--pace <ms>", "delay between output lines, for screen recording", "0")
  .parse();

const options = program.opts<{
  live: boolean;
  liveAgents?: string;
  record: boolean;
  only?: string;
  resume?: string;
  embedder: "auto" | "ollama" | "hash";
  pace: string;
}>();
const pace = Number(options.pace);
const AGENTS: AgentName[] = ["intent", "implementer", "reviewer"];
const liveAgents = new Set<AgentName>(
  options.live ? AGENTS : AGENTS.filter((agent) => (options.liveAgents ?? "").split(",").includes(agent)),
);
const INDENT = "      ";

async function say(line = ""): Promise<void> {
  console.log(line);
  if (pace > 0) {
    await sleep(pace);
  }
}

function plural(count: number, word: string): string {
  if (count === 1) {
    return `${count} ${word}`;
  }
  return `${count} ${word === "criterion" ? "criteria" : `${word}s`}`;
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

function routeText(label: string, route: RouteSummary | null | undefined): string {
  return route ? `${label} → ${route.tier}/${route.model}` : `${label} → ${pc.red("refused")}`;
}

function provenanceText(mode: "live" | "replay", provenance: string, model: string): string {
  return pc.dim(`[${mode} · ${provenance === "hand-authored" ? "hand-authored" : model}]`);
}

async function printStep(step: Step, state: RunState, resumed: boolean): Promise<void> {
  const prefix = resumed ? pc.dim(`${INDENT}(resumed: ${step} already done) `) : "";
  if (resumed) {
    await say(prefix.trimEnd());
    return;
  }
  if (step === "retrieve" && state.context) {
    const context = state.context;
    const count =
      context.components.length + context.functions.length + context.contracts.length + context.owners.length;
    await say(
      `${INDENT}Retrieved ${count} context nodes from graph (${plural(context.components.length, "component")}, ${plural(context.functions.length, "function")}, ${plural(context.contracts.length, "contract")}, ${plural(context.owners.length, "owner")})`,
    );
    const knowledge = context.documents.map((document) => document.name);
    await say(
      pc.dim(
        `${INDENT}Target ${context.target?.name ?? "none"} · withheld ${plural(context.withheld.length, "financial node")} outside write scope${context.withheld.length > 0 ? `: ${context.withheld.map((node) => node.name).join(", ")}` : ""}${knowledge.length > 0 ? ` · history: ${knowledge.join("; ")}` : ""}`,
      ),
    );
    if (state.suspended && state.breaker) {
      await say(
        `${INDENT}${pc.red(pc.bold("SUSPENDED."))} Circuit breaker open on ${state.breaker.surface} after ${state.breaker.consecutiveBlocks} consecutive blocks. No agent was called. Reset: pnpm release breaker reset ${state.breaker.surface} --by <name>`,
      );
    }
  } else if (step === "intent" && !state.proposal && !state.suspended) {
    const failure = state.agentErrors.find((error) => error.agent === "intent");
    await say(
      `${INDENT}Intent: ${pc.yellow("agent failed")} ${pc.dim(`(${failure?.message.slice(0, 70) ?? "unknown"}); continuing from the raw request, never autonomous`)}`,
    );
  } else if (step === "intent" && state.proposal) {
    const { output, provenance } = state.proposal;
    await say(
      `${INDENT}Intent: ${output.summary || "(no summary)"} · ${plural(output.acceptance.length, "criterion")}  ${provenanceText(liveAgents.has("intent") ? "live" : "replay", provenance.provenance, provenance.model)}`,
    );
  } else if (step === "implement" && state.diff) {
    const lines = state.diff.patch.split("\n").filter((line) => /^[+-](?![+-]{2})/.test(line)).length;
    const files = state.diff.patch.split("\n").filter((line) => line.startsWith("+++ ")).length;
    await say(
      `${INDENT}Implementer: diff produced, ${plural(lines, "line")}, ${plural(files, "file")}  ${provenanceText(state.diff.mode, state.diff.meta.provenance, state.diff.meta.model)}`,
    );
    const rejected = [...new Set([...(state.diff.route?.rejected ?? []), ...(state.proposal?.route?.rejected ?? [])])];
    await say(
      pc.dim(
        `${INDENT}Router: ${routeText("intent", state.proposal?.route)} · ${routeText("implement", state.diff.route)}${rejected.length > 0 ? ` · refused: ${rejected[0]}` : ""}`,
      ),
    );
    await say();
  } else if (step === "gates" && state.gates) {
    for (const gate of state.gates.results) {
      await say(gateLine(gate));
      if (gate.status !== "pass") {
        for (const reason of gate.reasons.slice(0, 4)) {
          await say(`${INDENT}       ${gate.status === "fail" ? pc.red(reason) : pc.dim(reason)}`);
        }
      }
    }
  } else if (step === "review") {
    if (!state.review) {
      const failure = state.agentErrors.find((error) => error.agent === "reviewer");
      await say(
        failure
          ? `${INDENT}Review: ${pc.yellow("reviewer failed")} ${pc.dim(`(${failure.message.slice(0, 70)}); fails safe, never autonomous`)}`
          : `${INDENT}Review: ${pc.dim("not run. Gates blocked the diff, so no model time was spent reviewing it.")}`,
      );
      return;
    }
    const { output, provenance, route } = state.review;
    const high = output.objections.filter((objection) => objection.severity === "high").length;
    await say(
      `${INDENT}Adversarial review (${route ? `${route.tier}/${route.model}` : provenance.model}, a different model family): ${plural(output.objections.length, "objection")}, ${high} high  ${provenanceText(liveAgents.has("reviewer") ? "live" : "replay", provenance.provenance, provenance.model)}`,
    );
    for (const objection of output.objections.slice(0, 2)) {
      const text = objection.message.length > 110 ? `${objection.message.slice(0, 107)}...` : objection.message;
      await say(`${INDENT}  ${pc.dim("·")} ${objection.severity === "high" ? pc.yellow(text) : pc.dim(text)}`);
    }
  } else if (step === "decide" && state.gates && state.verdict && state.release && state.breaker) {
    const { risk } = state.gates;
    const tierColour = risk.tier === "HIGH" ? pc.red : risk.tier === "MEDIUM" ? pc.yellow : pc.green;
    const headline = risk.signals[0];
    await say(
      `${INDENT}Risk tier: ${tierColour(pc.bold(risk.tier))}${state.verdict === "BLOCKED" && headline ? pc.dim(` (${headline.message})`) : ""}`,
    );
    if (state.verdict !== "BLOCKED") {
      for (const signal of risk.signals.slice(0, 4)) {
        await say(`${INDENT}  ${pc.dim("·")} ${signal.message}`);
      }
    }
    await say();
    if (state.verdict === "AUTONOMOUS") {
      await say(
        `${INDENT}${pc.green(pc.bold("ELIGIBLE FOR AUTONOMOUS DEPLOY."))} ${pc.dim("Would enter canary at 1% (deploy itself is simulated in this slice).")}`,
      );
    } else if (state.verdict === "NAMED_APPROVAL") {
      const approvers = risk.approvers.map((approver) => `${approver.handle} (${approver.rule})`).join(", ");
      await say(
        `${INDENT}${pc.yellow(pc.bold("HELD FOR NAMED APPROVER:"))} ${approvers || pc.red("no CODEOWNERS entry, cannot proceed until one exists")}`,
      );
      await say(`${INDENT}${pc.dim("Every gate passed. The tier alone requires a human; HIGH is never autonomous.")}`);
    } else if (state.verdict === "HUMAN_REVIEW") {
      await say(
        `${INDENT}${pc.yellow(pc.bold("HELD FOR HUMAN REVIEW."))} ${pc.dim("MEDIUM risk, a gate could not verify, or the reviewer raised a high objection.")}`,
      );
    } else {
      await say(
        `${INDENT}${pc.red(pc.bold("BLOCKED."))} Diff discarded. No human review consumed. No deploy attempted.`,
      );
    }
    await say(
      pc.dim(
        `${INDENT}Release: ${state.release.deploy} · breaker ${state.breaker.surface} ${state.breaker.consecutiveBlocks}/${state.breaker.max}${state.breaker.open ? " OPEN" : ""} · kill switch ${control.killSwitch ? "ON" : "off"} · run ${state.runId}`,
      ),
    );
  }
}

const config = loadConfig();
const router = loadRouterConfig();
const control = loadControl();
const runsDir = join(STATE_DIR, "runs");
// The demo uses its own breaker file, reset each run, so repeated demos stay reproducible.
const breakerPath = join(STATE_DIR, "demo-breaker.json");
if (!options.resume && existsSync(breakerPath)) {
  rmSync(breakerPath);
}
const breaker = new CircuitBreaker(breakerPath, control.breaker.maxConsecutiveBlocks);
const auditPath = join(STATE_DIR, "audit.jsonl");
const audit = new AuditLog(auditPath);

const all = (
  JSON.parse(readFileSync(join(REPO_ROOT, "fixtures", "change-requests.json"), "utf8")) as { requests: ChangeRequest[] }
).requests;
const resumed = options.resume ? loadRun(runsDir, options.resume) : undefined;
if (options.resume && !resumed) {
  throw new Error(`No checkpoint for run ${options.resume} in ${runsDir}`);
}
const only = options.only?.split(",").map((id) => id.trim());
const requests = resumed ? [resumed.request] : only ? all.filter((request) => only.includes(request.id)) : all;

await say(pc.bold("Zevoy Collective · working slice"));
await say(pc.dim("Agents propose. The control plane disposes. Every decision below is made by code, not by a model."));
await say();

const index = await ingest({ root: TARGET_ROOT, config, contractPath: OPENAPI_PATH, embedder: options.embedder });
const contract = index.contract;
if (!contract) {
  throw new Error("fixture contract failed to load");
}
await say(
  `Ingest   target-app @ ${index.commitSha} · ${index.modules.length} files + ${plural(index.documents, "doc")} → ${index.stats.totalNodes} nodes, ${index.stats.totalEdges} edges · ${index.chunks.length} symbol- and heading-bounded chunks · ${index.durationMs} ms`,
);
await say(
  pc.dim(`         graph ${index.graph.backend} · vectors ${index.vectors.backend} · embedder ${index.embedder.name}`),
);
await say(
  pc.dim(
    liveAgents.size > 0
      ? `         live agents: ${[...liveAgents].join(", ")} on local Ollama${options.record ? " (recording to fixtures/recorded)" : ""}; others replay`
      : "         agents REPLAY recordings from fixtures/recorded, each labelled with who produced it (--live reruns them)",
  ),
);

const outcomes: RunState[] = [];
for (const [position, request] of requests.entries()) {
  await say();
  await say(`${pc.bold(`[${position + 1}/${requests.length}]`)} Change request: ${pc.cyan(`"${request.request}"`)}`);
  const state = await runSwarm(
    request,
    {
      root: TARGET_ROOT,
      config,
      contract,
      graph: index.graph,
      vectors: index.vectors,
      embedder: index.embedder,
      router,
      control,
      breaker,
      audit,
      liveAgents,
      record: options.record,
      runsDir,
      onStep: printStep,
    },
    resumed,
  );
  outcomes.push(state);
}

await say();
await say(pc.bold("Summary"));
for (const state of outcomes) {
  const results = state.gates?.results ?? [];
  const failed = results.filter((gate) => gate.status === "fail").length;
  const skipped = results.filter((gate) => gate.status === "skip").length;
  const passed = results.filter((gate) => gate.status === "pass").length;
  const gates = state.suspended
    ? "not run"
    : failed > 0
      ? `${failed} FAIL${skipped > 0 ? `, ${skipped} SKIP` : ""}`
      : `${passed}/${results.length} PASS`;
  const verdict = state.suspended
    ? pc.red("suspended by circuit breaker")
    : {
        AUTONOMOUS: pc.green("autonomous-eligible"),
        NAMED_APPROVAL: pc.yellow(
          `named approver ${state.gates?.risk.approvers.map((approver) => approver.handle).join(", ") ?? ""}`,
        ),
        HUMAN_REVIEW: pc.yellow("human review"),
        BLOCKED: pc.red("blocked before any human saw it"),
      }[state.verdict ?? "BLOCKED"];
  await say(`  ${state.request.id}  ${(state.gates?.risk.tier ?? "-").padEnd(6)} ${gates.padEnd(16)} → ${verdict}`);
}
const verified = verifyAudit(auditPath);
const runIds = new Set(outcomes.map((state) => state.runId));
const thisRun = outcomes.reduce((sum, state) => sum + runEntries(auditPath, state.runId).length, 0);
const egress = egressLog();
const refused = egress.filter((record) => !record.allowed).length;
const hosts = [...new Set(egress.map((record) => record.host))];
await say();
await say(
  pc.dim(
    `Audit    ${verified.ok ? "hash chain verified" : pc.red(`CHAIN BROKEN at #${verified.brokenAt}`)} · ${thisRun} events from ${runIds.size} runs appended (${verified.entries} in .zevoy/audit.jsonl)`,
  ),
);
await say(
  pc.dim(
    `Egress   ${plural(egress.length, "outbound call")}${hosts.length > 0 ? ` to ${hosts.join(", ")}` : ""} · ${refused} refused · allow-list ${router.egressAllowList.join(", ")}`,
  ),
);
const usage = [...usageByAgent().entries()];
await say(
  pc.dim(
    `Metering ${usage.length > 0 ? usage.map(([agent, total]) => `${agent} ${total.tokens} tok/${(total.ms / 1000).toFixed(1)}s`).join(" · ") : "no model calls this run (replay)"}`,
  ),
);
