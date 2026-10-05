import type { CanaryConfig } from "./control";

/** Aggregated metrics for one population (baseline or canary) over the same observation window. */
export interface MetricWindow {
  requests: number;
  errors: number;
  p95LatencyMs: number;
  conversions: number;
  sessions: number;
}

export type CanaryAction = "promote" | "hold" | "rollback";

export interface CanaryDecision {
  action: CanaryAction;
  /** Stage to move to. Equals the current stage on hold; null on rollback or once 100% is promoted (fully rolled out). */
  nextStage: number | null;
  reasons: string[];
}

export type GateVerdict = "AUTONOMOUS" | "HUMAN_REVIEW" | "NAMED_APPROVAL" | "BLOCKED";

export interface ReleaseInput {
  verdict: GateVerdict;
  killSwitch: boolean;
  breakerOpen: boolean;
}

export interface ReleaseDecision {
  deploy: "autonomous-canary" | "human-gated" | "none";
  reason: string;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * Decides the next step of a progressive rollout from baseline vs canary metrics. Pure and deterministic.
 * Regression checks run before the sample-size check: a canary that is already visibly worse is rolled back
 * immediately rather than left serving traffic while it accumulates samples.
 */
export function evaluateCanary(
  baseline: MetricWindow,
  canary: MetricWindow,
  stage: number,
  config: CanaryConfig,
): CanaryDecision {
  const stageIndex = config.stages.indexOf(stage);
  if (stageIndex === -1) {
    throw new Error(`stage ${stage} is not one of the configured stages (${config.stages.join(", ")})`);
  }

  const rollback: string[] = [];

  const baselineErrorRate = rate(baseline.errors, baseline.requests);
  const canaryErrorRate = rate(canary.errors, canary.requests);
  const errorDelta = canaryErrorRate - baselineErrorRate;
  if (errorDelta > config.maxErrorRateDelta) {
    rollback.push(
      [
        `error rate ${percent(canaryErrorRate)} vs baseline ${percent(baselineErrorRate)}`,
        `(+${percent(errorDelta)} > max +${percent(config.maxErrorRateDelta)})`,
      ].join(" "),
    );
  }

  const latencyRatio =
    baseline.p95LatencyMs > 0 ? canary.p95LatencyMs / baseline.p95LatencyMs : canary.p95LatencyMs > 0 ? Infinity : 1;
  if (latencyRatio > config.maxP95LatencyRatio) {
    rollback.push(
      [
        `p95 latency ${canary.p95LatencyMs}ms vs baseline ${baseline.p95LatencyMs}ms`,
        `(ratio ${latencyRatio.toFixed(2)} > max ${config.maxP95LatencyRatio.toFixed(2)})`,
      ].join(" "),
    );
  }

  const baselineConversion = rate(baseline.conversions, baseline.sessions);
  const canaryConversion = rate(canary.conversions, canary.sessions);
  const conversionDrop = baselineConversion - canaryConversion;
  if (conversionDrop > config.maxConversionDrop) {
    rollback.push(
      [
        `conversion ${percent(canaryConversion)} vs baseline ${percent(baselineConversion)}`,
        `(-${percent(conversionDrop)} > max -${percent(config.maxConversionDrop)})`,
      ].join(" "),
    );
  }

  if (rollback.length > 0) {
    return { action: "rollback", nextStage: null, reasons: rollback };
  }

  if (canary.requests < config.minSamples) {
    return {
      action: "hold",
      nextStage: stage,
      reasons: [`${canary.requests} canary requests < ${config.minSamples} required samples at ${stage}%`],
    };
  }

  const nextStage = config.stages[stageIndex + 1] ?? null;
  const healthy = [
    `error rate ${percent(canaryErrorRate)} vs baseline ${percent(baselineErrorRate)}`,
    `p95 ratio ${latencyRatio.toFixed(2)}`,
    `conversion ${percent(canaryConversion)} vs baseline ${percent(baselineConversion)}`,
    `${canary.requests} samples`,
  ].join(", ");
  return {
    action: "promote",
    nextStage,
    reasons: [
      nextStage === null ? `fully rolled out at ${stage}%: ${healthy}` : `${stage}% -> ${nextStage}%: ${healthy}`,
    ],
  };
}

/**
 * Maps a gate verdict onto a deployment path. The kill switch and an open breaker never block a human-gated
 * release; they only remove the autonomous path, so AUTONOMOUS degrades to human-gated. BLOCKED never deploys.
 */
export function decideRelease(input: ReleaseInput): ReleaseDecision {
  if (input.verdict === "BLOCKED") {
    return { deploy: "none", reason: "gates blocked the diff; nothing to deploy" };
  }
  if (input.verdict !== "AUTONOMOUS") {
    return { deploy: "human-gated", reason: `verdict ${input.verdict} requires a human before deployment` };
  }
  if (input.killSwitch) {
    return { deploy: "human-gated", reason: "kill switch is on: autonomous deployment disabled" };
  }
  if (input.breakerOpen) {
    return { deploy: "human-gated", reason: "circuit breaker open for this surface: swarm suspended pending review" };
  }
  return { deploy: "autonomous-canary", reason: "verdict AUTONOMOUS: progressive canary with automatic rollback" };
}
