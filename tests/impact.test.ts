import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadContract } from "../src/analysis/openapi";
import { OPENAPI_PATH, REPO_ROOT } from "../src/config";
import { diffContracts, impactOf } from "../src/impact/drift";
import { testEnv } from "./helpers";

const before = loadContract(OPENAPI_PATH);
const after = loadContract(join(REPO_ROOT, "fixtures", "openapi.next.yaml"));

describe("back-end contract drift", () => {
  it("detects the four changes in the next release", () => {
    const changes = diffContracts(before, after);
    expect(changes.map((change) => [change.kind, change.method, change.path, change.property ?? null])).toEqual([
      ["request-property-removed", "PATCH", "/cards/{id}", "transactionLimit"],
      ["operation-removed", "GET", "/team", null],
      ["operation-added", "GET", "/cards/{id}/balance", null],
      ["operation-added", "PUT", "/cards/{id}/limits", null],
    ]);
    expect(changes[0]?.schema).toBe("CardSettingsUpdate");
  });

  it("reports no changes between identical contracts", () => {
    expect(diffContracts(before, before)).toEqual([]);
  });

  it("traces each change through the code graph to functions, components and owners", async () => {
    const { graph } = await testEnv();
    const impacts = await impactOf(diffContracts(before, after), graph);
    const find = (path: string) => impacts.find((impact) => impact.change.path === path);

    const limit = find("/cards/{id}");
    expect(limit?.functions.map((node) => node.name)).toEqual(["updateCardSettings"]);
    expect(limit?.components.map((node) => node.name)).toEqual(["CardSettingsPanel"]);
    expect(limit?.owners).toContain("@aino.virtanen");
    expect(limit?.changeRequest).toBe(
      "Migrate CardSettingsPanel off CardSettingsUpdate.transactionLimit to PUT /cards/{id}/limits",
    );

    const team = find("/team");
    expect(team?.functions.map((node) => node.name)).toEqual(["listTeamMembers"]);
    expect(team?.components.map((node) => node.name)).toEqual(["TeamMembers"]);
    expect(team?.owners).toContain("@sara.niemi");

    const balance = find("/cards/{id}/balance");
    expect(balance?.functions).toEqual([]);
    expect(balance?.components).toEqual([]);
    expect(balance?.owners).toEqual([]);
    expect(balance?.changeRequest).toBeNull();
  });
});
