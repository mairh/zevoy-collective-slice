import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ChangeRequest, implement, type RecordingMeta } from "../agent/implementer";
import { type ChangeProposal, proposeChange } from "../agent/intent";
import { applyReview, type Review, reviewDiff } from "../agent/reviewer";
import type { AgentName, Provenance } from "../agent/runAgent";
import type { Contract } from "../analysis/openapi";
import type { AuditLog } from "../audit/log";
import type { SliceConfig } from "../config";
import { type GateRun, runGates, type Verdict } from "../gates";
import type { Embedder } from "../ingest/embed";
import type { CircuitBreaker } from "../release/breaker";
import { decideRelease, type ReleaseDecision } from "../release/canary";
import type { ControlConfig } from "../release/control";
import { type RetrievedContext, resolveContext } from "../retrieve/resolve";
import type { RouteDecision, RouterConfig } from "../router/router";
import type { GraphStore } from "../stores/graph";
import type { VectorStore } from "../stores/vectors";
import { parseChangeSet } from "../workspace/changeSet";

export const STEPS = ["retrieve", "intent", "implement", "gates", "review", "decide"] as const;
export type Step = (typeof STEPS)[number];

export interface RouteSummary {
  model: string;
  tier: string;
  rejected: string[];
}

/** Everything a run has produced so far. Persisted after every step; this is the swarm's explicit shared state. */
export interface RunState {
  runId: string;
  request: ChangeRequest;
  completed: Step[];
  suspended: boolean;
  context?: RetrievedContext;
  proposal?: { output: ChangeProposal; provenance: Provenance; route: RouteSummary | null };
  diff?: { patch: string; meta: RecordingMeta; mode: "live" | "replay"; route: RouteSummary | null };
  gates?: GateRun;
  review?: { output: Review; provenance: Provenance; route: RouteSummary | null } | null;
  verdict?: Verdict;
  release?: ReleaseDecision;
  /** Agent calls that failed (timeouts, unparseable output). Each one makes the run fail safe, never fail open. */
  agentErrors: { agent: AgentName; message: string }[];
  breaker?: { surface: string; consecutiveBlocks: number; open: boolean; max: number };
}

export interface SwarmDeps {
  root: string;
  config: SliceConfig;
  contract: Contract;
  graph: GraphStore;
  vectors: VectorStore;
  embedder: Embedder;
  router: RouterConfig;
  control: ControlConfig;
  breaker: CircuitBreaker;
  audit: AuditLog;
  /** Agents that run live against local models; the rest replay their committed recordings. */
  liveAgents: ReadonlySet<AgentName>;
  record: boolean;
  runsDir: string;
  /** Called after each step completes (or is skipped on resume), so a CLI can stream progress. */
  onStep?: (step: Step, state: RunState, resumed: boolean) => Promise<void> | void;
}

function summariseRoute(decision: RouteDecision | null): RouteSummary | null {
  return decision
    ? {
        model: decision.model.model,
        tier: decision.model.tier,
        rejected: decision.rejected.map((entry) => `${entry.id}: ${entry.reason}`),
      }
    : null;
}

/** The surface a diff writes to: the deepest directory shared by its files. Used to key the circuit breaker. */
export function surfaceOf(paths: string[]): string {
  const split = paths.map((path) => path.split("/").slice(0, -1));
  const first = split[0] ?? [];
  const shared: string[] = [];
  for (const [index, segment] of first.entries()) {
    if (!split.every((parts) => parts[index] === segment)) {
      break;
    }
    shared.push(segment);
  }
  return shared.length > 0 ? `${shared.join("/")}/` : "./";
}

function save(dir: string, state: RunState): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${state.runId}.json`);
  writeFileSync(`${path}.tmp`, JSON.stringify(state));
  renameSync(`${path}.tmp`, path);
}

/** Loads a checkpointed run, or undefined if there is none. */
export function loadRun(dir: string, runId: string): RunState | undefined {
  const path = join(dir, `${runId}.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RunState) : undefined;
}

/**
 * The swarm, as an explicit state machine: retrieve → intent → implement → gates → review → decide. State is
 * checkpointed after every step, so a run that dies midway resumes from the last completed step without replaying
 * side effects (model calls, audit events, breaker records). Agents only ever add information; every decision is
 * made by deterministic code: the gates, the risk tier, applyReview, the breaker and decideRelease.
 */
export async function runSwarm(request: ChangeRequest, deps: SwarmDeps, resume?: RunState): Promise<RunState> {
  const state: RunState = resume ?? {
    runId: `${request.id}-${Date.now().toString(36)}`,
    request,
    completed: [],
    suspended: false,
    agentErrors: [],
  };
  const modeOf = (agent: AgentName): "live" | "replay" => (deps.liveAgents.has(agent) ? "live" : "replay");
  const optionsFor = (agent: AgentName) => ({ mode: modeOf(agent), record: deps.record, router: deps.router });
  const done = (step: Step) => state.completed.includes(step);
  const agentFailed = (agent: AgentName, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    state.agentErrors.push({ agent, message });
    deps.audit.append(state.runId, "model.call", { agent, failed: true, message });
  };
  const finish = async (step: Step) => {
    state.completed.push(step);
    save(deps.runsDir, state);
    await deps.onStep?.(step, state, false);
  };

  if (!resume) {
    deps.audit.append(state.runId, "run.started", {
      request: request.request,
      requestId: request.id,
      liveAgents: [...deps.liveAgents],
    });
  }

  for (const step of STEPS) {
    if (done(step)) {
      await deps.onStep?.(step, state, true);
      continue;
    }
    if (state.suspended) {
      break;
    }
    // Re-check the breaker before every step, so a resumed run cannot spend agent calls on a suspended surface.
    if (step !== "retrieve" && state.context?.target) {
      const surface = surfaceOf([state.context.target.sourceFile]);
      const current = deps.breaker.state(surface);
      if (current.open) {
        state.suspended = true;
        state.breaker = {
          surface,
          consecutiveBlocks: current.consecutiveBlocks,
          open: true,
          max: deps.control.breaker.maxConsecutiveBlocks,
        };
        deps.audit.append(state.runId, "breaker", { surface, open: true, action: `run suspended before ${step}` });
        save(deps.runsDir, state);
        break;
      }
    }
    if (step === "retrieve") {
      state.context = await resolveContext(request.request, {
        root: deps.root,
        graph: deps.graph,
        vectors: deps.vectors,
        embedder: deps.embedder,
        config: deps.config,
      });
      deps.audit.append(state.runId, "retrieval", {
        target: state.context.target?.id ?? null,
        nodes: [
          ...state.context.components,
          ...state.context.functions,
          ...state.context.contracts,
          ...state.context.owners,
        ].map((node) => node.id),
        withheld: state.context.withheld.map((node) => node.id),
        embedder: deps.embedder.name,
      });
      const surface = state.context.target ? surfaceOf([state.context.target.sourceFile]) : "./";
      const breakerState = deps.breaker.state(surface);
      if (breakerState.open) {
        // A suspended surface gets no agent calls at all until a named human resets the breaker.
        state.suspended = true;
        state.breaker = {
          surface,
          consecutiveBlocks: breakerState.consecutiveBlocks,
          open: true,
          max: deps.control.breaker.maxConsecutiveBlocks,
        };
        deps.audit.append(state.runId, "breaker", {
          surface,
          open: true,
          action: "run suspended before any agent call",
        });
      }
    } else if (step === "intent" && state.context) {
      const context = state.context;
      try {
        const run = await proposeChange(request.id, request.request, context, optionsFor("intent"));
        state.proposal = { output: run.output, provenance: run.provenance, route: summariseRoute(run.route) };
        deps.audit.append(state.runId, "intent", {
          proposal: run.output,
          provenance: run.provenance,
          route: state.proposal.route,
        });
      } catch (error) {
        // No proposal: the implementer works from the raw request, and the run can no longer be autonomous.
        agentFailed("intent", error);
      }
    } else if (step === "implement" && state.context) {
      const result = await implement(request, state.context, {
        mode: modeOf("implementer"),
        record: deps.record,
        root: deps.root,
        contract: deps.contract,
        router: deps.router,
        acceptance: state.proposal?.output.acceptance ?? [],
      }).catch((error: unknown) => {
        // An implementer that produces nothing usable yields an empty diff, which write-scope blocks.
        agentFailed("implementer", error);
        return {
          changeSet: parseChangeSet(request.id, "", deps.root),
          mode: modeOf("implementer"),
          meta: {
            requestId: request.id,
            provenance: "ollama" as const,
            model: "failed",
            promptVersion: "-",
            recordedAt: new Date().toISOString(),
          },
          summary: "",
          route: null,
        };
      });
      state.diff = {
        patch: result.changeSet.patch,
        meta: result.meta,
        mode: result.mode,
        route: summariseRoute(result.route),
      };
      deps.audit.append(state.runId, "diff", {
        files: result.changeSet.files.map((file) => file.path),
        linesChanged: result.changeSet.linesChanged,
        provenance: result.meta.provenance,
        model: result.meta.model,
        route: state.diff.route,
      });
    } else if (step === "gates" && state.diff) {
      const changeSet = parseChangeSet(request.id, state.diff.patch, deps.root);
      state.gates = await runGates(changeSet, {
        root: deps.root,
        config: deps.config,
        contract: deps.contract,
        graph: deps.graph,
        onResult: (result) => {
          deps.audit.append(state.runId, "gate", { gate: result.gate, status: result.status, reasons: result.reasons });
        },
      });
      deps.audit.append(state.runId, "risk", {
        tier: state.gates.risk.tier,
        signals: state.gates.risk.signals,
        approvers: state.gates.risk.approvers,
      });
    } else if (step === "review" && state.gates && state.diff) {
      // Nothing to review if a gate already blocked it: no model time is spent on a diff that cannot ship.
      if (state.gates.verdict === "BLOCKED") {
        state.review = null;
      } else {
        const proposal = state.proposal?.output ?? { summary: "", scope: [], acceptance: [], outOfScope: [] };
        try {
          const run = await reviewDiff(request.id, request.request, state.diff.patch, proposal, optionsFor("reviewer"));
          state.review = { output: run.output, provenance: run.provenance, route: summariseRoute(run.route) };
          deps.audit.append(state.runId, "review", {
            review: run.output,
            provenance: run.provenance,
            route: state.review.route,
          });
        } catch (error) {
          state.review = null;
          agentFailed("reviewer", error);
        }
      }
    } else if (step === "decide" && state.gates && state.diff) {
      const reviewed = applyReview(state.gates.verdict, state.review?.output ?? null);
      // Any agent failure on a diff that would otherwise ship autonomously sends it to a human instead.
      const verdict = reviewed === "AUTONOMOUS" && state.agentErrors.length > 0 ? "HUMAN_REVIEW" : reviewed;
      const surface = surfaceOf(parseChangeSet(request.id, state.diff.patch, deps.root).files.map((file) => file.path));
      const breakerState = deps.breaker.record(surface, verdict === "BLOCKED" ? "blocked" : "passed");
      state.verdict = verdict;
      state.breaker = {
        surface,
        consecutiveBlocks: breakerState.consecutiveBlocks,
        open: breakerState.open,
        max: deps.control.breaker.maxConsecutiveBlocks,
      };
      state.release = decideRelease({ verdict, killSwitch: deps.control.killSwitch, breakerOpen: breakerState.open });
      deps.audit.append(state.runId, "verdict", {
        gateVerdict: state.gates.verdict,
        verdict,
        approvers: state.gates.risk.approvers,
      });
      deps.audit.append(state.runId, "breaker", { ...state.breaker });
      deps.audit.append(state.runId, "release", { ...state.release, killSwitch: deps.control.killSwitch });
    }
    await finish(step);
  }
  if (!state.suspended && state.completed.includes("decide") && state.verdict === undefined) {
    // A checkpoint missing earlier outputs must never look like a finished run.
    throw new Error(`run ${state.runId} is inconsistent: decide completed without a verdict (corrupted checkpoint?)`);
  }
  return state;
}
