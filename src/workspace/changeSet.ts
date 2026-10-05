import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { applyPatch, parsePatch, type StructuredPatch } from "diff";

export type ChangeKind = "add" | "modify" | "delete";

export interface FileChange {
  /** POSIX path relative to the target repo root, as written in the diff. */
  path: string;
  kind: ChangeKind;
  before: string | null;
  after: string | null;
  /** 1-based line numbers in `after` that the diff added. */
  addedLines: Set<number>;
  /** 1-based line numbers in `before` that the diff removed. */
  removedLines: Set<number>;
  /** True when the path is absolute or climbs out of the repo. Such files are never read or applied. */
  escapesRoot: boolean;
}

export interface ChangeSet {
  id: string;
  patch: string;
  files: FileChange[];
  /** Added plus removed lines across all files. */
  linesChanged: number;
}

function stripPrefix(fileName: string | undefined): string {
  if (fileName === undefined || fileName === "/dev/null") {
    return "/dev/null";
  }
  return fileName.replace(/^[ab]\//, "").replace(/\t.*$/, "");
}

/** True when a diff path would resolve outside the repo root. */
export function pathEscapesRoot(path: string): boolean {
  if (isAbsolute(path) || /^[a-zA-Z]:/.test(path)) {
    return true;
  }
  const normalised = normalize(path).split("\\").join("/");
  return normalised === ".." || normalised.startsWith("../");
}

function hunkLineSets(patch: StructuredPatch): { added: Set<number>; removed: Set<number> } {
  const added = new Set<number>();
  const removed = new Set<number>();
  for (const hunk of patch.hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        added.add(newLine);
        newLine += 1;
      } else if (line.startsWith("-")) {
        removed.add(oldLine);
        oldLine += 1;
      } else if (!line.startsWith("\\")) {
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  return { added, removed };
}

/**
 * Parses a unified diff against the target repo and materialises before/after content for every file.
 * Throws if a hunk does not apply: a diff that does not apply cleanly is rejected before any gate runs.
 */
export function parseChangeSet(id: string, patchText: string, repoRoot: string): ChangeSet {
  const patches = parsePatch(patchText).filter((patch) => patch.hunks.length > 0);
  const files: FileChange[] = [];
  for (const patch of patches) {
    const oldPath = stripPrefix(patch.oldFileName);
    const newPath = stripPrefix(patch.newFileName);
    const kind: ChangeKind = oldPath === "/dev/null" ? "add" : newPath === "/dev/null" ? "delete" : "modify";
    const path = kind === "delete" ? oldPath : newPath;
    const { added, removed } = hunkLineSets(patch);
    if (pathEscapesRoot(path)) {
      files.push({
        path,
        kind,
        before: null,
        after: null,
        addedLines: added,
        removedLines: removed,
        escapesRoot: true,
      });
      continue;
    }
    const absolute = join(repoRoot, path);
    const before = kind === "add" ? null : existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
    if (kind !== "add" && before === null) {
      throw new Error(["Diff modifies ", path, " which does not exist in the target repo"].join(""));
    }
    let after: string | null = null;
    if (kind !== "delete") {
      const applied = applyPatch(before ?? "", patch);
      if (applied === false) {
        throw new Error(["Diff does not apply cleanly to ", path].join(""));
      }
      after = applied;
    }
    files.push({ path, kind, before, after, addedLines: added, removedLines: removed, escapesRoot: false });
  }
  const linesChanged = files.reduce((sum, file) => sum + file.addedLines.size + file.removedLines.size, 0);
  return { id, patch: patchText, files, linesChanged };
}
