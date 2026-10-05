import { describe, expect, it } from "vitest";
import { visualRegressionGate } from "../src/gates/visualRegression";
import { launchBrowser } from "../src/visual/harness";
import { fixtureContext } from "./helpers";

const chromeAvailable = await launchBrowser()
  .then(async (browser) => {
    await browser.close();
    return true;
  })
  .catch(() => false);

describe("visual-regression gate", () => {
  it("never renders a diff that failed a static gate", async () => {
    const result = await visualRegressionGate(await fixtureContext("R3"), { priorFailure: true });
    expect(result.status).toBe("skip");
    expect(result.pass).toBe(false);
  });

  it("passes a diff that adds a field without disturbing existing elements", async (context) => {
    if (!chromeAvailable) {
      context.skip();
    }
    const result = await visualRegressionGate(await fixtureContext("R2"), { priorFailure: false });
    expect(result.status).toBe("pass");
    expect(result.summary).toMatch(/^13 existing elements unchanged, 0 edited, 3 added$/);
  });

  it("fails a shared Button style change that alters every kept button", async (context) => {
    if (!chromeAvailable) {
      context.skip();
    }
    const result = await visualRegressionGate(await fixtureContext("visual-button-style"), { priorFailure: false });
    expect(result.status).toBe("fail");
    expect(result.findings.length).toBeGreaterThanOrEqual(2);
    expect(result.reasons.join("\n")).toContain('<button> "Request a card" changed size');
    expect(result.reasons.join("\n")).toContain('<button> "Save changes" changed size');
  });

  it("fails when the pre-diff render drifts from the committed baseline", async (context) => {
    if (!chromeAvailable) {
      context.skip();
    }
    const result = await visualRegressionGate(await fixtureContext("R1"), {
      priorFailure: false,
      baselineDir: new URL("./fixtures/wrong-baselines", import.meta.url).pathname,
    });
    expect(result.status).toBe("fail");
    expect(result.findings[0]?.rule).toBe("baseline-drift");
  });
});
