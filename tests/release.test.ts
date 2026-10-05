import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/release/breaker";
import { decideRelease, evaluateCanary, type MetricWindow } from "../src/release/canary";
import { loadControl } from "../src/release/control";

const SURFACE = "src/ui/cards/";

describe("circuit breaker", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zevoy-breaker-"));
    path = join(dir, "breaker.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts closed for an unknown surface", () => {
    expect(new CircuitBreaker(path, 3).state(SURFACE)).toEqual({
      surface: SURFACE,
      consecutiveBlocks: 0,
      open: false,
      openedAt: null,
    });
  });

  it("opens at exactly N consecutive blocks", () => {
    const breaker = new CircuitBreaker(path, 3);
    expect(breaker.record(SURFACE, "blocked").open).toBe(false);
    expect(breaker.record(SURFACE, "blocked").open).toBe(false);
    const third = breaker.record(SURFACE, "blocked");
    expect(third.open).toBe(true);
    expect(third.consecutiveBlocks).toBe(3);
    expect(third.openedAt).not.toBeNull();
  });

  it("resets the counter on a pass while closed", () => {
    const breaker = new CircuitBreaker(path, 3);
    breaker.record(SURFACE, "blocked");
    breaker.record(SURFACE, "blocked");
    expect(breaker.record(SURFACE, "passed").consecutiveBlocks).toBe(0);
    expect(breaker.record(SURFACE, "blocked").open).toBe(false);
  });

  it("stays open after a pass", () => {
    const breaker = new CircuitBreaker(path, 2);
    breaker.record(SURFACE, "blocked");
    const opened = breaker.record(SURFACE, "blocked");
    const afterPass = breaker.record(SURFACE, "passed");
    expect(afterPass.open).toBe(true);
    expect(afterPass.openedAt).toBe(opened.openedAt);
  });

  it("closes only on reset by a named human, and requires the name", () => {
    const breaker = new CircuitBreaker(path, 1);
    breaker.record(SURFACE, "blocked");
    expect(() => breaker.reset(SURFACE, "  ")).toThrow(/named human/);
    expect(breaker.state(SURFACE).open).toBe(true);
    breaker.reset(SURFACE, "Nish");
    expect(breaker.state(SURFACE)).toMatchObject({ open: false, consecutiveBlocks: 0, openedAt: null });
  });

  it("keeps surfaces independent", () => {
    const breaker = new CircuitBreaker(path, 1);
    breaker.record(SURFACE, "blocked");
    expect(breaker.state("src/ui/settings/").open).toBe(false);
  });

  it("persists across instances", () => {
    const first = new CircuitBreaker(path, 2);
    first.record(SURFACE, "blocked");
    first.record(SURFACE, "blocked");
    const second = new CircuitBreaker(path, 2);
    expect(second.state(SURFACE).open).toBe(true);
    second.reset(SURFACE, "Nish");
    expect(new CircuitBreaker(path, 2).state(SURFACE).open).toBe(false);
  });
});

describe("canary evaluation", () => {
  const config = loadControl().canary;
  const baseline: MetricWindow = {
    requests: 10_000,
    errors: 20,
    p95LatencyMs: 300,
    conversions: 700,
    sessions: 10_000,
  };
  const healthy: MetricWindow = { requests: 1_000, errors: 2, p95LatencyMs: 310, conversions: 70, sessions: 1_000 };

  it("promotes a healthy canary to the next stage", () => {
    const decision = evaluateCanary(baseline, healthy, 1, config);
    expect(decision).toEqual({
      action: "promote",
      nextStage: 10,
      reasons: [
        "1% -> 10%: error rate 0.20% vs baseline 0.20%, p95 ratio 1.03, conversion 7.00% vs baseline 7.00%, 1000 samples",
      ],
    });
  });

  it("returns nextStage null once 100% is promoted", () => {
    const decision = evaluateCanary(baseline, healthy, 100, config);
    expect(decision.action).toBe("promote");
    expect(decision.nextStage).toBeNull();
    expect(decision.reasons[0]).toMatch(/^fully rolled out at 100%/);
  });

  it("holds when the canary has fewer than minSamples requests", () => {
    const decision = evaluateCanary(baseline, { ...healthy, requests: 150, errors: 0 }, 10, config);
    expect(decision).toEqual({
      action: "hold",
      nextStage: 10,
      reasons: ["150 canary requests < 200 required samples at 10%"],
    });
  });

  it("rolls back on an error-rate regression", () => {
    const decision = evaluateCanary(baseline, { ...healthy, errors: 10 }, 10, config);
    expect(decision).toEqual({
      action: "rollback",
      nextStage: null,
      reasons: ["error rate 1.00% vs baseline 0.20% (+0.80% > max +0.50%)"],
    });
  });

  it("does not roll back an error-rate increase within the threshold", () => {
    expect(evaluateCanary(baseline, { ...healthy, errors: 6 }, 10, config).action).toBe("promote");
  });

  it("rolls back on a p95 latency regression", () => {
    const decision = evaluateCanary(baseline, { ...healthy, p95LatencyMs: 390 }, 10, config);
    expect(decision).toEqual({
      action: "rollback",
      nextStage: null,
      reasons: ["p95 latency 390ms vs baseline 300ms (ratio 1.30 > max 1.20)"],
    });
  });

  it("rolls back on a conversion drop", () => {
    const decision = evaluateCanary(baseline, { ...healthy, conversions: 40 }, 10, config);
    expect(decision).toEqual({
      action: "rollback",
      nextStage: null,
      reasons: ["conversion 4.00% vs baseline 7.00% (-3.00% > max -2.00%)"],
    });
  });

  it("rolls back a regression even before minSamples is reached, and cites every breach", () => {
    const decision = evaluateCanary(
      baseline,
      { requests: 100, errors: 5, p95LatencyMs: 400, conversions: 2, sessions: 100 },
      1,
      config,
    );
    expect(decision.action).toBe("rollback");
    expect(decision.reasons).toHaveLength(3);
  });

  it("rejects a stage that is not configured", () => {
    expect(() => evaluateCanary(baseline, healthy, 25, config)).toThrow(/not one of the configured stages/);
  });
});

describe("release decision", () => {
  it("routes AUTONOMOUS to an autonomous canary when nothing is tripped", () => {
    expect(decideRelease({ verdict: "AUTONOMOUS", killSwitch: false, breakerOpen: false }).deploy).toBe(
      "autonomous-canary",
    );
  });

  it("turns AUTONOMOUS into human-gated when the kill switch is on", () => {
    const decision = decideRelease({ verdict: "AUTONOMOUS", killSwitch: true, breakerOpen: false });
    expect(decision).toEqual({ deploy: "human-gated", reason: "kill switch is on: autonomous deployment disabled" });
  });

  it("turns AUTONOMOUS into human-gated when the breaker is open", () => {
    const decision = decideRelease({ verdict: "AUTONOMOUS", killSwitch: false, breakerOpen: true });
    expect(decision.deploy).toBe("human-gated");
    expect(decision.reason).toContain("circuit breaker open");
  });

  it("keeps human verdicts human-gated", () => {
    expect(decideRelease({ verdict: "HUMAN_REVIEW", killSwitch: false, breakerOpen: false }).deploy).toBe(
      "human-gated",
    );
    expect(decideRelease({ verdict: "NAMED_APPROVAL", killSwitch: true, breakerOpen: true }).deploy).toBe(
      "human-gated",
    );
  });

  it("never deploys BLOCKED, even with nothing tripped", () => {
    expect(decideRelease({ verdict: "BLOCKED", killSwitch: false, breakerOpen: false }).deploy).toBe("none");
  });
});

describe("control config", () => {
  let dir: string;
  const previous = process.env.ZEVOY_KILL_SWITCH;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zevoy-control-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) {
      delete process.env.ZEVOY_KILL_SWITCH;
    } else {
      process.env.ZEVOY_KILL_SWITCH = previous;
    }
  });

  it("loads the committed policy with the kill switch off", () => {
    delete process.env.ZEVOY_KILL_SWITCH;
    const control = loadControl();
    expect(control.killSwitch).toBe(false);
    expect(control.breaker.maxConsecutiveBlocks).toBe(3);
    expect(control.canary.stages).toEqual([1, 10, 50, 100]);
  });

  it("forces the kill switch on with ZEVOY_KILL_SWITCH=1", () => {
    const path = join(dir, "control.json");
    writeFileSync(path, JSON.stringify({ ...loadControl(), killSwitch: false }));
    process.env.ZEVOY_KILL_SWITCH = "1";
    expect(loadControl(path).killSwitch).toBe(true);
  });
});
