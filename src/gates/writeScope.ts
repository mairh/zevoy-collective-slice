import picomatch from "picomatch";
import type { AllowlistConfig } from "../config";
import type { ChangeSet } from "../workspace/changeSet";
import { type Finding, type GateResult, resultFromFindings } from "./types";

function commonDirectory(paths: string[]): string {
  const split = paths.map((path) => path.split("/").slice(0, -1));
  const first = split[0] ?? [];
  const shared: string[] = [];
  for (let index = 0; index < first.length; index += 1) {
    const segment = first[index];
    if (segment !== undefined && split.every((parts) => parts[index] === segment)) {
      shared.push(segment);
    } else {
      break;
    }
  }
  return shared.length === 0 ? "./" : `${shared.join("/")}/`;
}

/**
 * Gate 1. Every path in the diff must match an allow glob and no deny glob. Deny wins even when nested inside
 * an allowed path. Runs first because it removes whole categories of failure rather than detecting them.
 */
export function writeScopeGate(changeSet: ChangeSet, allowlist: AllowlistConfig): GateResult {
  const allow = allowlist.allow.map((glob) => ({ glob, test: picomatch(glob, { dot: true }) }));
  // Deny is case-insensitive: on macOS and Windows `src/Ledger/` and `src/ledger/` are the same directory.
  const deny = allowlist.deny.map((glob) => ({ glob, test: picomatch(glob, { dot: true, nocase: true }) }));
  const findings: Finding[] = [];
  for (const file of changeSet.files) {
    if (file.escapesRoot) {
      findings.push({ rule: "path-escape", file: file.path, line: null, message: "path escapes the repo root" });
      continue;
    }
    const denied = deny.find((rule) => rule.test(file.path));
    if (denied) {
      findings.push({ rule: "denied-path", file: file.path, line: null, message: `path denied by ${denied.glob}` });
      continue;
    }
    if (!allow.some((rule) => rule.test(file.path))) {
      findings.push({
        rule: "outside-allowlist",
        file: file.path,
        line: null,
        message: `path outside allowlist (${allowlist.allow.join(", ")})`,
      });
    }
  }
  if (changeSet.files.length === 0) {
    findings.push({ rule: "empty-diff", file: "-", line: null, message: "diff touches no files" });
  }
  return resultFromFindings(
    "write-scope",
    findings,
    `${commonDirectory(changeSet.files.map((file) => file.path))} only`,
  );
}
