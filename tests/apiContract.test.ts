import { describe, expect, it } from "vitest";
import { apiContractGate } from "../src/gates/apiContract";
import { fixtureContext } from "./helpers";

async function run(name: string) {
  return apiContractGate(await fixtureContext(name));
}

describe("api-contract gate", () => {
  it("resolves updateCardSettings through the wrapper to PATCH /cards/{id} and validates the body", async () => {
    const result = await run("R2");
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("PATCH /cards/{id} matches schema");
  });

  it("fails a hallucinated endpoint and the fields read from it", async () => {
    const result = await run("R3");
    expect(result.status).toBe("fail");
    expect(result.findings.map((finding) => finding.rule)).toEqual(["hallucinated-endpoint", "unverifiable-response"]);
    expect(result.findings[0]?.message).toBe(
      "hallucinated endpoint: GET /api/v2/balance (outside the contract's server base /api/v1)",
    );
    expect(result.findings[1]?.message).toContain("available, currency");
  });

  it("fails a body field the schema does not declare", async () => {
    const result = await run("contract-unknown-field");
    expect(result.findings[0]).toMatchObject({
      rule: "request-body",
      message: "field body.spendingCap is not in the schema (CardSettingsUpdate)",
    });
  });

  it("fails a method the path does not allow", async () => {
    const result = await run("contract-wrong-method");
    expect(result.findings[0]).toMatchObject({
      rule: "method-not-allowed",
      message: "DELETE not allowed on /cards/{param}/freeze (contract allows POST)",
    });
  });

  it("validates a literal body with ajv against the referenced schema", async () => {
    const result = await run("contract-literal-body");
    const messages = result.findings.map((finding) => finding.message);
    expect(
      messages.some((message) =>
        message.startsWith("ajv: /amount/currency must be equal to one of the allowed values"),
      ),
    ).toBe(true);
  });

  it("fails a response field that is not in the response schema", async () => {
    const result = await run("contract-response-field");
    expect(result.findings[0]).toMatchObject({
      rule: "response-field",
      message: "response field pendingReview is not in Card",
    });
  });
});

describe("api-contract sees through bracket access and aliases", () => {
  it.each(["evasion-bracket-fetch", "evasion-self-fetch", "evasion-alias-fetch"])(
    "flags the hallucinated endpoint in %s",
    async (fixture) => {
      const result = await run(fixture);
      expect(result.findings[0]?.rule).toBe("hallucinated-endpoint");
    },
  );
});
