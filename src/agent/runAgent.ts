import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../config";
import { ollamaAvailable, ollamaChatJson } from "../router/ollama";
import { type DataClass, type RouteDecision, type RouterConfig, route, type TaskClass } from "../router/router";
import { PROMPT_VERSION } from "./prompt";

export type AgentName = "intent" | "implementer" | "reviewer";

export interface Provenance {
  provenance: "hand-authored" | "ollama";
  model: string;
  promptVersion: string;
  recordedAt: string;
}

export interface AgentRun<T> {
  output: T;
  mode: "live" | "replay";
  provenance: Provenance;
  /** Routing decision for live runs; for replays, the decision the router would make now. */
  route: RouteDecision | null;
}

export interface AgentOptions {
  mode: "live" | "replay";
  record?: boolean;
  router: RouterConfig;
}

interface Recording<T> extends Provenance {
  requestId: string;
  agent: AgentName;
  /** Absent when the recorded call failed; replaying it reproduces the same failure. */
  output?: T;
  error?: string;
}

export class RecordedAgentError extends Error {}

function recordingPath(requestId: string, agent: AgentName): string {
  return join(REPO_ROOT, "fixtures", "recorded", `${requestId}.${agent}.json`);
}

/**
 * Runs one agent call either live (routed, egress-guarded, metered) or from a committed recording. Recordings keep
 * their provenance, so a replay always says whether a model or a person produced it.
 */
export async function runAgent<T>(spec: {
  agent: AgentName;
  requestId: string;
  task: TaskClass;
  dataClass: DataClass;
  messages: () => { system: string; user: string };
  parse: (raw: string) => T;
  options: AgentOptions;
  maxTokens: number;
}): Promise<AgentRun<T>> {
  const path = recordingPath(spec.requestId, spec.agent);
  if (spec.options.mode === "replay") {
    if (!existsSync(path)) {
      throw new Error(`No ${spec.agent} recording for ${spec.requestId}. Run with --live --record.`);
    }
    const recording = JSON.parse(readFileSync(path, "utf8")) as Recording<T>;
    if (recording.output === undefined) {
      throw new RecordedAgentError(`recorded failure (${recording.model}): ${recording.error ?? "unknown"}`);
    }
    const decision = await route(spec.task, spec.dataClass, spec.options.router, ollamaAvailable).catch(() => null);
    return {
      output: recording.output,
      mode: "replay",
      provenance: {
        provenance: recording.provenance,
        model: recording.model,
        promptVersion: recording.promptVersion,
        recordedAt: recording.recordedAt,
      },
      route: decision,
    };
  }
  const decision = await route(spec.task, spec.dataClass, spec.options.router, ollamaAvailable);
  const provenance: Provenance = {
    provenance: "ollama",
    model: decision.model.model,
    promptVersion: PROMPT_VERSION,
    recordedAt: new Date().toISOString(),
  };
  const save = (recording: Recording<T>) => {
    if (spec.options.record) {
      writeFileSync(path, `${JSON.stringify(recording, null, 2)}\n`);
    }
  };
  let output: T;
  try {
    const raw = await ollamaChatJson(decision.model, spec.messages(), {
      agent: spec.agent,
      changeId: spec.requestId,
      dataClass: spec.dataClass,
      maxTokens: spec.maxTokens,
    });
    output = spec.parse(raw);
  } catch (error) {
    // Failures are recorded too, so a replay reproduces exactly what the model did, including breaking.
    save({
      requestId: spec.requestId,
      agent: spec.agent,
      ...provenance,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  save({ requestId: spec.requestId, agent: spec.agent, ...provenance, output });
  return { output, mode: "live", provenance, route: decision };
}

/** Reads a string-array field from untyped model JSON, dropping anything that is not a string. */
export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Parses model JSON into an object, or throws a clear error. */
export function jsonObject(raw: string): object {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("agent returned non-object JSON");
  }
  return parsed;
}
