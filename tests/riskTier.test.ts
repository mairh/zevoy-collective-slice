import { describe, expect, it } from "vitest";
import { classifyRisk } from "../src/gates/riskTier";
import { fixtureContext } from "./helpers";

async function classify(name: string) {
  return classifyRisk(await fixtureContext(name));
}

describe("risk tier", () => {
  it("LOW for a copy and layout change on a non-financial surface", async () => {
    const risk = await classify("R1");
    expect(risk.tier).toBe("LOW");
    expect(risk.autonomousEligible).toBe(true);
    expect(risk.approvers).toEqual([]);
  });

  it("MEDIUM for new component state with no money, form or permission involvement", async () => {
    const risk = await classify("risk-medium-state");
    expect(risk.tier).toBe("MEDIUM");
    expect(risk.signals.map((signal) => signal.rule)).toContain("state-shape");
  });

  it("HIGH for the transaction limit, with reasons and a named approver from CODEOWNERS", async () => {
    const risk = await classify("R2");
    expect(risk.tier).toBe("HIGH");
    const rules = risk.signals.map((signal) => signal.rule);
    expect(rules).toEqual(expect.arrayContaining(["money-rendering", "submit-form", "amount-field"]));
    expect(risk.approvers).toEqual([{ handle: "@aino.virtanen", rule: "CODEOWNERS /src/ui/cards/" }]);
    expect(risk.autonomousEligible).toBe(false);
  });

  it("HIGH for anything that reads a balance", async () => {
    const risk = await classify("R3");
    expect(risk.tier).toBe("HIGH");
    expect(risk.signals.find((signal) => signal.rule === "amount-field")?.message).toContain("balance");
  });
});

describe("risk tier uses contract sensitivity", () => {
  it("HIGH for a new call to an endpoint the contract marks financial", async () => {
    const risk = await classify("risk-financial-endpoint");
    expect(risk.tier).toBe("HIGH");
    expect(risk.signals[0]?.message).toBe("new API call to existing financial endpoint: GET /cards/{id}");
  });
});
