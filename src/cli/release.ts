import { Command } from "commander";
import pc from "picocolors";
import { CircuitBreaker, DEFAULT_BREAKER_PATH } from "../release/breaker";
import { evaluateCanary, type MetricWindow } from "../release/canary";
import { loadControl } from "../release/control";

const control = loadControl();

/** SIMULATED: baseline metrics are hard-coded synthetic numbers. There is no real deployment in this slice. */
const SIMULATED_BASELINE: MetricWindow = {
  requests: 50_000,
  errors: 100,
  p95LatencyMs: 320,
  conversions: 2_100,
  sessions: 30_000,
};

/**
 * SIMULATED: canary observation windows per stage, in order. The first window at 1% is deliberately under-sampled
 * so the walk shows a hold before the promote. `regression` degrades latency and conversion at 10%.
 */
const SIMULATED_SCENARIOS: Record<string, Record<number, MetricWindow[]>> = {
  healthy: {
    1: [
      { requests: 120, errors: 0, p95LatencyMs: 318, conversions: 5, sessions: 70 },
      { requests: 520, errors: 1, p95LatencyMs: 325, conversions: 22, sessions: 310 },
    ],
    10: [{ requests: 5_000, errors: 11, p95LatencyMs: 330, conversions: 208, sessions: 3_000 }],
    50: [{ requests: 25_000, errors: 52, p95LatencyMs: 327, conversions: 1_046, sessions: 15_000 }],
    100: [{ requests: 50_000, errors: 101, p95LatencyMs: 322, conversions: 2_095, sessions: 30_000 }],
  },
  regression: {
    1: [{ requests: 520, errors: 1, p95LatencyMs: 330, conversions: 21, sessions: 310 }],
    10: [{ requests: 5_000, errors: 14, p95LatencyMs: 455, conversions: 120, sessions: 3_000 }],
  },
};

function describeWindow(window: MetricWindow): string {
  return [
    `${window.requests} req`,
    `${window.errors} err`,
    `p95 ${window.p95LatencyMs}ms`,
    `${window.conversions}/${window.sessions} conv`,
  ].join(", ");
}

function simulateCanary(scenario: string): void {
  const windows = SIMULATED_SCENARIOS[scenario];
  if (windows === undefined) {
    throw new Error(`unknown scenario ${scenario}; expected one of ${Object.keys(SIMULATED_SCENARIOS).join(", ")}`);
  }
  console.log(pc.yellow(pc.bold("SIMULATED METRICS — no real deployment in this slice")));
  console.log(`baseline: ${describeWindow(SIMULATED_BASELINE)}`);
  let stage: number | null = control.canary.stages[0] ?? null;
  while (stage !== null) {
    const observations = windows[stage] ?? [];
    let advanced = false;
    for (const window of observations) {
      const decision = evaluateCanary(SIMULATED_BASELINE, window, stage, control.canary);
      const label =
        decision.action === "promote"
          ? pc.green("PROMOTE")
          : decision.action === "hold"
            ? pc.yellow("HOLD")
            : pc.red(pc.bold("ROLLBACK"));
      console.log(`stage ${String(stage).padStart(3)}%  ${describeWindow(window)}`);
      for (const reason of decision.reasons) {
        console.log(`        ${label} ${reason}`);
      }
      if (decision.action === "rollback") {
        console.log(pc.red(`rolled back at ${stage}%: traffic returned to baseline (simulated)`));
        return;
      }
      if (decision.action === "promote") {
        if (decision.nextStage === null) {
          console.log(pc.green("fully rolled out at 100% (simulated)"));
          return;
        }
        stage = decision.nextStage;
        advanced = true;
        break;
      }
    }
    if (!advanced) {
      console.log(pc.yellow(`held at ${stage}%: scenario has no further observations (simulated)`));
      return;
    }
  }
}

const program = new Command().name("release").description("Release-safety controls: circuit breaker and canary");

const breaker = program.command("breaker").description(`repeated-failure circuit breaker (${DEFAULT_BREAKER_PATH})`);

breaker
  .command("status")
  .description("show breaker state per surface")
  .action(() => {
    const states = new CircuitBreaker(DEFAULT_BREAKER_PATH, control.breaker.maxConsecutiveBlocks).all();
    console.log(`kill switch: ${control.killSwitch ? pc.red("ON") : "off"}`);
    if (states.length === 0) {
      console.log("no surfaces recorded");
      return;
    }
    for (const state of states) {
      const status = state.open ? pc.red(`OPEN since ${state.openedAt ?? "?"}`) : pc.green("closed");
      console.log(
        `${state.surface}  ${status}  consecutive blocks ${state.consecutiveBlocks}/${control.breaker.maxConsecutiveBlocks}`,
      );
    }
  });

breaker
  .command("reset <surface>")
  .description("close the breaker for a surface after human review")
  .requiredOption("--by <name>", "the human taking responsibility for the reset")
  .action((surface: string, options: { by: string }) => {
    new CircuitBreaker(DEFAULT_BREAKER_PATH, control.breaker.maxConsecutiveBlocks).reset(surface, options.by);
    console.log(`breaker for ${surface} reset by ${options.by}`);
  });

program
  .command("canary")
  .description("walk a canary rollout through the configured stages")
  .requiredOption("--simulate <scenario>", `synthetic scenario: ${Object.keys(SIMULATED_SCENARIOS).join(" | ")}`)
  .action((options: { simulate: string }) => {
    simulateCanary(options.simulate);
  });

program.parse();
