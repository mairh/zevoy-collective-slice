import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../config";

export interface BreakerConfig {
  maxConsecutiveBlocks: number;
}

export interface CanaryConfig {
  /** Traffic percentages, ascending, ending at 100. */
  stages: number[];
  /** Canary requests required before any promote decision. */
  minSamples: number;
  /** Absolute error-rate increase over baseline that triggers rollback, e.g. 0.005 = 0.5 percentage points. */
  maxErrorRateDelta: number;
  /** canary p95 / baseline p95 above which the canary rolls back. */
  maxP95LatencyRatio: number;
  /** Absolute conversion-rate drop below baseline that triggers rollback. */
  maxConversionDrop: number;
}

export interface ControlConfig {
  killSwitch: boolean;
  breaker: BreakerConfig;
  canary: CanaryConfig;
}

/**
 * Loads the release-control policy. `ZEVOY_KILL_SWITCH=1` forces the kill switch on regardless of the file, so an
 * operator can halt autonomous deployment without a commit. The env var can only turn the switch on, never off.
 */
export function loadControl(path: string = join(REPO_ROOT, "config", "control.json")): ControlConfig {
  const config = JSON.parse(readFileSync(path, "utf8")) as ControlConfig;
  if (process.env.ZEVOY_KILL_SWITCH === "1") {
    return { ...config, killSwitch: true };
  }
  return config;
}
