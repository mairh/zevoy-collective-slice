import { describe, expect, it } from "vitest";
import { EgressDeniedError, egressLog, guardedFetch } from "../src/router/egress";
import { loadRouterConfig, type ModelSpec, RouteRefusedError, route } from "../src/router/router";

const config = loadRouterConfig();
const everythingUp = async () => true;
const localOnly = async (model: ModelSpec) => model.provider === "ollama";

describe("router", () => {
  it("never sends raw repository content to a commercial tier, even when one is available", async () => {
    const decision = await route("code-generation", "proprietary-source", config, everythingUp);
    expect(decision.model.id).toBe("local-coder");
    expect(decision.rejected).toEqual([
      { id: "claude-mid", reason: "mid tier not permitted for proprietary-source data" },
    ]);
  });

  it("prefers the commercial tier for internal intent work when it is reachable", async () => {
    const decision = await route("intent", "internal", config, everythingUp);
    expect(decision.model.id).toBe("claude-mid");
  });

  it("falls back only to a tier that is permitted, and says why", async () => {
    const decision = await route("intent", "internal", config, localOnly);
    expect(decision.model.id).toBe("local-coder");
    expect(decision.rejected[0]?.id).toBe("claude-mid");
  });

  it("fails closed when nothing permitted can serve: architecture reasoning on financial data", async () => {
    await expect(route("architecture-reasoning", "financial", config, everythingUp)).rejects.toBeInstanceOf(
      RouteRefusedError,
    );
  });

  it("fails closed when the only permitted model is down", async () => {
    await expect(route("embedding", "proprietary-source", config, async () => false)).rejects.toThrow(
      /no model may serve embedding/,
    );
  });
});

describe("egress guard", () => {
  it("refuses hosts outside the allow-list before any request and logs the attempt", async () => {
    await expect(
      guardedFetch("https://api.example.com/v1", {}, { purpose: "test", dataClass: "proprietary-source" }),
    ).rejects.toBeInstanceOf(EgressDeniedError);
    expect(egressLog().at(-1)).toMatchObject({
      host: "api.example.com",
      allowed: false,
      dataClass: "proprietary-source",
    });
  });
});

describe("egress guard and redirects", () => {
  it("refuses to follow a redirect from an allowed host", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_request, response) => {
      response.writeHead(302, { location: "https://example.com/exfiltrate" });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await expect(
      guardedFetch(`http://127.0.0.1:${port}/`, {}, { purpose: "test", dataClass: "proprietary-source" }),
    ).rejects.toThrow();
    server.close();
  });
});
