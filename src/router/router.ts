import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../config";
import { setEgressAllowList } from "./egress";

export type Tier = "frontier" | "mid" | "local";
export type TaskClass = "architecture-reasoning" | "intent" | "code-generation" | "adversarial-review" | "embedding";
/** What the call carries. Raw repository content and financial data may only be served by self-hosted models. */
export type DataClass = "public" | "internal" | "proprietary-source" | "financial";

export interface ModelSpec {
  id: string;
  tier: Tier;
  provider: "anthropic" | "ollama";
  model: string;
  zeroRetention: boolean;
}

export interface RouterConfig {
  egressAllowList: string[];
  models: Record<string, Omit<ModelSpec, "id">>;
  taskRoutes: Record<TaskClass, string[]>;
  dataBoundaries: Record<DataClass, Tier[]>;
}

export interface RouteDecision {
  task: TaskClass;
  dataClass: DataClass;
  model: ModelSpec;
  /** Candidates considered and why each was passed over, in preference order. */
  rejected: { id: string; reason: string }[];
}

export class RouteRefusedError extends Error {
  constructor(
    readonly task: TaskClass,
    readonly dataClass: DataClass,
    readonly rejected: { id: string; reason: string }[],
  ) {
    super(
      `no model may serve ${task} on ${dataClass} data: ${rejected.map((entry) => `${entry.id} (${entry.reason})`).join("; ")}`,
    );
  }
}

/** Checks whether a model can serve right now. Injected so routing stays a pure, testable decision. */
export type Availability = (model: ModelSpec) => Promise<boolean>;

/** Loads config/router.json and applies its egress allow-list. */
export function loadRouterConfig(path: string = join(REPO_ROOT, "config", "router.json")): RouterConfig {
  const config = JSON.parse(readFileSync(path, "utf8")) as RouterConfig;
  setEgressAllowList(config.egressAllowList);
  return config;
}

/**
 * Routes one model call on three axes, in this order:
 * 1. Sensitivity, fail-closed: the data class fixes which tiers are permitted. Nothing is ever retried on a tier
 *    that is allowed less; if no permitted model can serve, the call fails loudly.
 * 2. Task class: each task lists candidate models in preference order (the order a parity harness maintains).
 * 3. Cost and availability: the first permitted, reachable candidate wins; commercial candidates also need
 *    zero-retention terms and a host on the egress allow-list.
 */
export async function route(
  task: TaskClass,
  dataClass: DataClass,
  config: RouterConfig,
  available: Availability,
): Promise<RouteDecision> {
  const permittedTiers = config.dataBoundaries[dataClass] ?? [];
  const rejected: { id: string; reason: string }[] = [];
  for (const id of config.taskRoutes[task] ?? []) {
    const spec = config.models[id];
    if (!spec) {
      rejected.push({ id, reason: "not configured" });
      continue;
    }
    const model: ModelSpec = { id, ...spec };
    if (!permittedTiers.includes(model.tier)) {
      rejected.push({ id, reason: `${model.tier} tier not permitted for ${dataClass} data` });
      continue;
    }
    if (model.provider !== "ollama" && !model.zeroRetention) {
      rejected.push({ id, reason: "no zero-retention terms" });
      continue;
    }
    if (!(await available(model))) {
      rejected.push({
        id,
        reason:
          model.provider === "anthropic"
            ? "commercial tier: no client in this slice and its host is not on the egress allow-list"
            : "not reachable",
      });
      continue;
    }
    return { task, dataClass, model, rejected };
  }
  throw new RouteRefusedError(task, dataClass, rejected);
}
