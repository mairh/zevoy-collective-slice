import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type AuditEventType =
  | "run.started"
  | "intent"
  | "retrieval"
  | "route"
  | "model.call"
  | "diff"
  | "gate"
  | "review"
  | "risk"
  | "verdict"
  | "release"
  | "breaker"
  | "human.decision";

export interface AuditEntry {
  seq: number;
  at: string;
  runId: string;
  type: AuditEventType;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

function digest(entry: Omit<AuditEntry, "hash">): string {
  return createHash("sha256")
    .update(JSON.stringify([entry.seq, entry.at, entry.runId, entry.type, entry.data, entry.prevHash]))
    .digest("hex");
}

function readEntries(path: string): AuditEntry[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as AuditEntry);
}

/**
 * Append-only, hash-chained audit trail. Each entry commits to the previous entry's hash, so editing or deleting
 * any past line breaks verification from that point on. Records every agent action, model and tier, gate result,
 * verdict and human decision: the artefact an auditor asks for.
 */
export class AuditLog {
  private lastHash: string;
  private nextSeq: number;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    const entries = readEntries(path);
    const last = entries.at(-1);
    this.lastHash = last?.hash ?? GENESIS;
    this.nextSeq = (last?.seq ?? 0) + 1;
  }

  /** Appends one event and returns it with its hash. */
  append(runId: string, type: AuditEventType, data: Record<string, unknown>): AuditEntry {
    const base = { seq: this.nextSeq, at: new Date().toISOString(), runId, type, data, prevHash: this.lastHash };
    const entry: AuditEntry = { ...base, hash: digest(base) };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    this.lastHash = entry.hash;
    this.nextSeq += 1;
    return entry;
  }
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  brokenAt: number | null;
  reason: string | null;
}

/** Recomputes the whole chain. Reports the first entry whose hash or back-link does not hold. */
export function verifyAudit(path: string): VerifyResult {
  const entries = readEntries(path);
  let previous = GENESIS;
  for (const entry of entries) {
    if (entry.prevHash !== previous) {
      return {
        ok: false,
        entries: entries.length,
        brokenAt: entry.seq,
        reason: "back-link does not match previous entry",
      };
    }
    const { hash, ...rest } = entry;
    if (digest(rest) !== hash) {
      return {
        ok: false,
        entries: entries.length,
        brokenAt: entry.seq,
        reason: "entry content does not match its hash",
      };
    }
    previous = hash;
  }
  return { ok: true, entries: entries.length, brokenAt: null, reason: null };
}

/** Entries for one run, in order, for replay. */
export function runEntries(path: string, runId: string): AuditEntry[] {
  return readEntries(path).filter((entry) => entry.runId === runId);
}
