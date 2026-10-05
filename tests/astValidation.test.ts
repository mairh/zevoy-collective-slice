import { describe, expect, it } from "vitest";
import { astValidationGate } from "../src/gates/astValidation";
import { fixtureContext } from "./helpers";

async function run(name: string) {
  return astValidationGate(await fixtureContext(name));
}

describe("ast-validation gate", () => {
  it("passes the transaction-limit diff: no new deps, network, eval, suppression, banking or env", async () => {
    const result = await run("R2");
    expect(result.status).toBe("pass");
  });

  it("fails a new raw fetch with rule, file and line", async () => {
    const result = await run("R3");
    expect(result.status).toBe("fail");
    expect(result.findings).toEqual([
      {
        rule: "new-network-call",
        file: "src/ui/cards/useAvailableBalance.ts",
        line: 9,
        message: "new network call introduced: fetch(`/api/v2/balance?cardId=${cardId}`)",
      },
    ]);
  });

  it("fails an import that is not in package.json", async () => {
    const result = await run("ast-new-dependency");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ rule: "new-dependency", line: 1, message: expect.stringContaining("canvas-confetti") }),
    );
  });

  it("fails dangerouslySetInnerHTML", async () => {
    const result = await run("ast-dynamic-eval");
    expect(result.findings.map((finding) => finding.rule)).toEqual(["dynamic-evaluation"]);
  });

  it("fails eslint-disable and @ts-ignore, each on its own line", async () => {
    const result = await run("ast-suppression");
    const rules = result.findings.map((finding) => `${finding.rule}:${finding.message}:${finding.line}`);
    expect(rules).toContain("suppressed-check:check suppressed: @ts-ignore:11");
    expect(rules).toContain("suppressed-check:check suppressed: eslint-disable:15");
  });

  it("fails a direct banking client import from UI code", async () => {
    const result = await run("ast-banking-client");
    expect(result.findings[0]).toMatchObject({
      rule: "banking-client-import",
      file: "src/ui/cards/CardListItem.tsx",
      line: 1,
    });
  });

  it("fails a process.env read", async () => {
    const result = await run("ast-env-access");
    expect(result.findings[0]).toMatchObject({
      rule: "env-access",
      message: "environment read introduced: process.env.FEATURE_FREEZE",
    });
  });

  it("does not blame a diff for a fetch that already existed", async () => {
    const result = await run("ast-preexisting-fetch");
    expect(result.status).toBe("pass");
  });
});

describe("ast-validation resolves callees through the type checker, not source text", () => {
  it.each([
    ["evasion-bracket-fetch", "new-network-call"],
    ["evasion-self-fetch", "new-network-call"],
    ["evasion-alias-fetch", "new-network-call"],
    ["evasion-bracket-xhr", "new-network-call"],
    ["evasion-bracket-eval", "dynamic-evaluation"],
    ["evasion-bracket-env", "env-access"],
    ["evasion-computed-import", "dynamic-evaluation"],
  ])("fails %s with %s", async (fixture, rule) => {
    const result = await run(fixture);
    expect(result.status).toBe("fail");
    expect(result.findings.map((finding) => finding.rule)).toContain(rule);
  });
});

describe("ast-validation compile check", () => {
  it("fails real qwen2.5-coder:7b output that does not compile, with line numbers", async () => {
    const result = await run("live-qwen-R2");
    expect(result.status).toBe("fail");
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        rule: "does-not-compile",
        line: 22,
        message: "does not compile: Cannot find name 'formatMoney'.",
      }),
    );
  });

  it("does not blame the diff for errors that already existed", async () => {
    const result = await run("R2");
    expect(result.findings.filter((finding) => finding.rule === "does-not-compile")).toEqual([]);
  });
});
