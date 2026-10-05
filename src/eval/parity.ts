import { type ChangeRequest, filesToPatch, parseModelOutput } from "../agent/implementer";
import { INTENT_MAX_TOKENS, intentMessages, parseProposal } from "../agent/intent";
import { buildImplementerPrompt } from "../agent/prompt";
import type { Contract } from "../analysis/openapi";
import type { SliceConfig } from "../config";
import { runGates } from "../gates";
import type { RetrievedContext } from "../retrieve/resolve";
import { ollamaChatJson } from "../router/ollama";
import type { ModelSpec } from "../router/router";
import type { GraphStore } from "../stores/graph";
import { parseChangeSet } from "../workspace/changeSet";

export type ParityTask = "intent" | "code-generation";

export interface ParitySample {
  requestId: string;
  ok: boolean;
  detail: string;
  ms: number;
}

export interface ParityScore {
  model: string;
  samples: ParitySample[];
  successRate: number;
  meanMs: number;
}

export interface ParityReport {
  task: ParityTask;
  candidate: ParityScore;
  baseline: ParityScore;
  /** Parity holds when the cheaper candidate succeeds at least as often as the baseline on the golden requests. */
  holds: boolean;
  recommendation: string;
}

async function sample(
  task: ParityTask,
  model: ModelSpec,
  request: ChangeRequest,
  context: RetrievedContext,
  env: { root: string; config: SliceConfig; contract: Contract; graph: GraphStore },
): Promise<ParitySample> {
  const started = performance.now();
  try {
    if (task === "intent") {
      const raw = await ollamaChatJson(model, intentMessages(request.request, context), {
        agent: "parity:intent",
        changeId: request.id,
        dataClass: "internal",
        maxTokens: INTENT_MAX_TOKENS,
      });
      const proposal = parseProposal(raw);
      const ok = proposal.acceptance.length > 0;
      return {
        requestId: request.id,
        ok,
        detail: ok ? `${proposal.acceptance.length} criteria` : "no acceptance criteria",
        ms: Math.round(performance.now() - started),
      };
    }
    const prompt = buildImplementerPrompt(request.request, context, env.contract);
    const raw = await ollamaChatJson(model, prompt, {
      agent: "parity:implementer",
      changeId: request.id,
      dataClass: "proprietary-source",
      maxTokens: 6000,
    });
    const patch = filesToPatch(env.root, parseModelOutput(raw).files);
    const run = await runGates(parseChangeSet(request.id, patch, env.root), {
      root: env.root,
      config: env.config,
      contract: env.contract,
      graph: env.graph,
    });
    const failed = run.results.filter((result) => result.status === "fail").map((result) => result.gate);
    return {
      requestId: request.id,
      ok: failed.length === 0,
      detail: failed.length === 0 ? `gates passed (${run.verdict})` : `failed ${failed.join(", ")}`,
      ms: Math.round(performance.now() - started),
    };
  } catch (error) {
    return {
      requestId: request.id,
      ok: false,
      detail: `invalid output: ${error instanceof Error ? error.message.slice(0, 60) : String(error)}`,
      ms: Math.round(performance.now() - started),
    };
  }
}

function score(model: ModelSpec, samples: ParitySample[]): ParityScore {
  return {
    model: model.model,
    samples,
    successRate: samples.length === 0 ? 0 : samples.filter((entry) => entry.ok).length / samples.length,
    meanMs: samples.length === 0 ? 0 : Math.round(samples.reduce((sum, entry) => sum + entry.ms, 0) / samples.length),
  };
}

/**
 * Parity harness. Runs the same golden requests through a cheaper candidate tier and the current baseline, scores
 * both deterministically (valid intent output; or a generated diff passing every gate), and says whether traffic
 * may move down. Tiers move down only on evidence, and move back up when parity degrades.
 */
export async function runParity(spec: {
  task: ParityTask;
  candidate: ModelSpec;
  baseline: ModelSpec;
  requests: { request: ChangeRequest; context: RetrievedContext }[];
  env: { root: string; config: SliceConfig; contract: Contract; graph: GraphStore };
}): Promise<ParityReport> {
  const run = async (model: ModelSpec) => {
    const samples: ParitySample[] = [];
    for (const { request, context } of spec.requests) {
      samples.push(await sample(spec.task, model, request, context, spec.env));
    }
    return score(model, samples);
  };
  const candidate = await run(spec.candidate);
  const baseline = await run(spec.baseline);
  const holds = baseline.successRate > 0 && candidate.successRate >= baseline.successRate;
  return {
    task: spec.task,
    candidate,
    baseline,
    holds,
    recommendation: holds
      ? `parity holds: route ${spec.task} to ${spec.candidate.id} (${candidate.model}) ahead of ${spec.baseline.id}`
      : `parity fails: keep ${spec.task} on ${spec.baseline.id} (${baseline.model}); ${candidate.model} succeeded ${Math.round(candidate.successRate * 100)}% vs ${Math.round(baseline.successRate * 100)}%`,
  };
}
