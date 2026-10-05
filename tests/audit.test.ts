import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog, runEntries, verifyAudit } from "../src/audit/log";

function freshLog() {
  const path = join(mkdtempSync(join(tmpdir(), "audit-")), "audit.jsonl");
  const log = new AuditLog(path);
  log.append("run-1", "run.started", { request: "R2" });
  log.append("run-1", "gate", { gate: "write-scope", status: "pass" });
  log.append("run-1", "verdict", { verdict: "NAMED_APPROVAL" });
  return path;
}

describe("audit trail", () => {
  it("verifies an untouched chain and continues it across instances", () => {
    const path = freshLog();
    new AuditLog(path).append("run-2", "run.started", { request: "R3" });
    expect(verifyAudit(path)).toEqual({ ok: true, entries: 4, brokenAt: null, reason: null });
    expect(runEntries(path, "run-1").map((entry) => entry.type)).toEqual(["run.started", "gate", "verdict"]);
  });

  it("detects an edited past entry", () => {
    const path = freshLog();
    writeFileSync(path, readFileSync(path, "utf8").replace('"status":"pass"', '"status":"fail"'));
    expect(verifyAudit(path)).toMatchObject({
      ok: false,
      brokenAt: 2,
      reason: "entry content does not match its hash",
    });
  });

  it("detects a deleted entry", () => {
    const path = freshLog();
    const lines = readFileSync(path, "utf8").trim().split("\n");
    writeFileSync(path, `${[lines[0], lines[2]].join("\n")}\n`);
    expect(verifyAudit(path)).toMatchObject({
      ok: false,
      brokenAt: 3,
      reason: "back-link does not match previous entry",
    });
  });
});
