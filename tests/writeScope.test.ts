import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { writeScopeGate } from "../src/gates/writeScope";
import { fixtureChangeSet } from "./helpers";

const { allowlist } = loadConfig();

describe("write-scope gate", () => {
  it("passes a diff confined to src/ui/cards", () => {
    const result = writeScopeGate(fixtureChangeSet("R2"), allowlist);
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("src/ui/cards/ only");
  });

  it("fails a diff into the ledger, even though deny is checked before allow", () => {
    const result = writeScopeGate(fixtureChangeSet("write-scope-ledger"), allowlist);
    expect(result.status).toBe("fail");
    expect(result.findings[0]).toMatchObject({ rule: "denied-path", file: "src/ledger/ledgerMath.ts" });
    expect(result.reasons[0]).toContain("**/ledger/**");
  });

  it("fails when the agent edits its own visual harness fixture, although it sits inside src/ui", () => {
    const result = writeScopeGate(fixtureChangeSet("write-scope-fixture"), allowlist);
    expect(result.status).toBe("fail");
    expect(result.findings[0]?.message).toContain("**/*.fixture.tsx");
  });

  it("fails a diff outside the allowlist", () => {
    const result = writeScopeGate(fixtureChangeSet("write-scope-outside"), allowlist);
    expect(result.status).toBe("fail");
    expect(result.findings[0]).toMatchObject({ rule: "outside-allowlist", file: "src/api/cards.ts" });
  });

  it("fails a path that climbs out of the repo and never reads it", () => {
    const changeSet = fixtureChangeSet("write-scope-escape");
    expect(changeSet.files[0]?.escapesRoot).toBe(true);
    expect(changeSet.files[0]?.after).toBeNull();
    const result = writeScopeGate(changeSet, allowlist);
    expect(result.findings[0]?.rule).toBe("path-escape");
  });

  it("fails nested denies inside an allowed path", () => {
    const changeSet = { ...fixtureChangeSet("R1") };
    changeSet.files = changeSet.files.map((file) => ({ ...file, path: "src/ui/transactions/Export.tsx" }));
    expect(writeScopeGate(changeSet, allowlist).findings[0]?.message).toContain("**/transactions/**");
  });
});
