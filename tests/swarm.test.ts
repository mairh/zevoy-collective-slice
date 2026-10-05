import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyReview } from "../src/agent/reviewer";
import { AuditLog, runEntries } from "../src/audit/log";
import { loadConfig, OPENAPI_PATH, TARGET_ROOT } from "../src/config";
import { ingest } from "../src/ingest";
import { CircuitBreaker } from "../src/release/breaker";
import { loadControl } from "../src/release/control";
import { loadRouterConfig } from "../src/router/router";
import { loadRun, runSwarm, type SwarmDeps } from "../src/swarm/orchestrator";

async function deps(overrides: Partial<SwarmDeps> = {}): Promise<SwarmDeps> {
  const dir = mkdtempSync(join(tmpdir(), "swarm-"));
  const config = loadConfig();
  const index = await ingest({
    root: TARGET_ROOT,
    config,
    contractPath: OPENAPI_PATH,
    embedder: "hash",
    stateDir: dir,
  });
  const control = loadControl();
  const contract = index.contract;
  if (!contract) {
    throw new Error("contract missing");
  }
  return {
    root: TARGET_ROOT,
    config,
    contract,
    graph: index.graph,
    vectors: index.vectors,
    embedder: index.embedder,
    router: loadRouterConfig(),
    control,
    breaker: new CircuitBreaker(join(dir, "breaker.json"), control.breaker.maxConsecutiveBlocks),
    audit: new AuditLog(join(dir, "audit.jsonl")),
    liveAgents: new Set(),
    record: false,
    runsDir: join(dir, "runs"),
    ...overrides,
  };
}

describe("review policy", () => {
  it("a high objection can only escalate an autonomous verdict", () => {
    const high = { objections: [{ severity: "high" as const, message: "x" }] };
    expect(applyReview("AUTONOMOUS", high)).toBe("HUMAN_REVIEW");
    expect(applyReview("BLOCKED", { objections: [] })).toBe("BLOCKED");
    expect(applyReview("NAMED_APPROVAL", high)).toBe("NAMED_APPROVAL");
    expect(applyReview("AUTONOMOUS", { objections: [{ severity: "low", message: "wording" }] })).toBe("AUTONOMOUS");
  });
});

describe("swarm orchestrator", () => {
  it("replays R3 end to end: blocked, no review spent, breaker counts the block, every step audited", async () => {
    const swarm = await deps();
    const state = await runSwarm(
      { id: "R3", request: "Fetch the user's available balance and show it on the card settings panel" },
      swarm,
    );
    expect(state.verdict).toBe("BLOCKED");
    expect(state.review).toBeNull();
    expect(state.breaker).toMatchObject({ surface: "src/ui/cards/", consecutiveBlocks: 1, open: false });
    expect(state.release?.deploy).toBe("none");
    const types = runEntries(swarm.audit.path, state.runId).map((entry) => entry.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "run.started",
        "retrieval",
        "intent",
        "diff",
        "gate",
        "risk",
        "verdict",
        "breaker",
        "release",
      ]),
    );
  }, 120_000);

  it("resumes from a checkpoint without replaying completed steps or their audit events", async () => {
    const swarm = await deps();
    const full = await runSwarm(
      {
        id: "R1",
        request: "Make the empty state on the cards page explain what company cards are for and who approves new ones",
      },
      swarm,
    );
    const checkpoint = loadRun(swarm.runsDir, full.runId);
    if (!checkpoint) {
      throw new Error("no checkpoint");
    }
    checkpoint.completed = checkpoint.completed.filter((step) => step !== "decide");
    const before = runEntries(swarm.audit.path, full.runId).length;
    const resumed: string[] = [];
    await runSwarm(
      checkpoint.request,
      { ...swarm, onStep: (step, _state, wasResumed) => void (wasResumed && resumed.push(step)) },
      checkpoint,
    );
    expect(resumed).toEqual(["retrieve", "intent", "implement", "gates", "review"]);
    const added = runEntries(swarm.audit.path, full.runId)
      .slice(before)
      .map((entry) => entry.type);
    expect(added).toEqual(["verdict", "breaker", "release"]);
  }, 120_000);

  it("suspends a surface after repeated blocks without calling any agent", async () => {
    const swarm = await deps();
    const request = { id: "R3", request: "Fetch the user's available balance and show it on the card settings panel" };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await runSwarm(request, swarm);
    }
    const suspended = await runSwarm(request, swarm);
    expect(suspended.suspended).toBe(true);
    expect(suspended.completed).toEqual(["retrieve"]);
    expect(suspended.diff).toBeUndefined();
  }, 240_000);

  it("failing agents fail safe: no recording means no proposal, an empty diff, and a block", async () => {
    const swarm = await deps();
    const state = await runSwarm(
      { id: "R404", request: "Add a transaction limit field to the card settings panel" },
      swarm,
    );
    expect(state.agentErrors.map((error) => error.agent)).toEqual(["intent", "implementer"]);
    expect(state.gates?.results[0]).toMatchObject({ gate: "write-scope", status: "fail" });
    expect(state.verdict).toBe("BLOCKED");
  }, 120_000);
});
