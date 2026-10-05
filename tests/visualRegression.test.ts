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

describe("render sandbox (defence in depth, independent of the static gates)", () => {
  const empty = "src/ui/cards/CardEmptyState.tsx";

  it("refuses to bundle an import that leaves the target repo", async (context) => {
    if (!chromeAvailable) {
      context.skip();
    }
    const { readFileSync } = await import("node:fs");
    const { TARGET_ROOT } = await import("../src/config");
    const { renderFixture } = await import("../src/visual/harness");
    const source = readFileSync(`${TARGET_ROOT}/${empty}`, "utf8");
    const escaped = `import { REPO_ROOT } from "../../../../src/config";\nconsole.log(REPO_ROOT);\n${source}`;
    const browser = await launchBrowser();
    try {
      await expect(
        renderFixture(browser, TARGET_ROOT, "src/ui/cards/CardEmptyState.fixture.tsx", new Map([[empty, escaped]])),
      ).rejects.toThrow(/import outside the target repo refused/);
    } finally {
      await browser.close();
    }
  });

  it("blocks WebSocket connections from rendered agent code", async (context) => {
    if (!chromeAvailable) {
      context.skip();
    }
    const { createServer } = await import("node:http");
    const { readFileSync } = await import("node:fs");
    const { TARGET_ROOT } = await import("../src/config");
    const { renderFixture } = await import("../src/visual/harness");
    let upgrades = 0;
    const server = createServer();
    server.on("upgrade", (_request, socket) => {
      upgrades += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const source = readFileSync(`${TARGET_ROOT}/${empty}`, "utf8");
    const probe = `new WebSocket("ws://127.0.0.1:${port}/exfil");\n${source}`;
    const browser = await launchBrowser();
    try {
      await expect(
        renderFixture(browser, TARGET_ROOT, "src/ui/cards/CardEmptyState.fixture.tsx", new Map([[empty, probe]])),
      ).rejects.toThrow(/Content Security Policy/);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(upgrades).toBe(0);
    } finally {
      await browser.close();
      server.close();
    }
  });
});
