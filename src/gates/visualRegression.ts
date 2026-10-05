import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { SourceFile } from "ts-morph";
import { isCodeFile } from "../analysis/project";
import { BASELINE_DIR } from "../config";
import { topLevelSymbols } from "../ingest/parse";
import {
  BrowserUnavailableError,
  baselineName,
  compareElement,
  comparePngs,
  findFixtures,
  launchBrowser,
  type Rendering,
  renderFixture,
} from "../visual/harness";
import { type Finding, formatFinding, type GateContext, type GateResult } from "./types";

/** Share of an element's pixels allowed to differ before it counts as changed. */
export const ELEMENT_TOLERANCE = 0.01;
/** Share of the whole pre-diff render allowed to differ from the committed baseline. */
export const BASELINE_TOLERANCE = 0.002;

export interface VisualOptions {
  /** True when an earlier static gate failed. The diff is then never executed. */
  priorFailure: boolean;
  baselineDir?: string;
}

function importClosure(start: SourceFile, root: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const file = stack.pop();
    if (!file) {
      continue;
    }
    const path = file.getFilePath().slice(root.length + 1);
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    for (const declaration of file.getImportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (target?.getFilePath().startsWith(root) && !target.getFilePath().includes("/node_modules/")) {
        stack.push(target);
      }
    }
  }
  return seen;
}

function skip(reasons: string[], summary: string): GateResult {
  return { gate: "visual-regression", status: "skip", pass: false, summary, reasons, findings: [] };
}

function compareRenderings(fixture: string, before: Rendering, after: Rendering, findings: Finding[]) {
  const afterByKey = new Map(after.elements.map((element) => [element.key, element]));
  const beforeKeys = new Set(before.elements.map((element) => element.key));
  let unchanged = 0;
  for (const element of before.elements) {
    const match = afterByKey.get(element.key);
    if (!match) {
      continue;
    }
    const diff = compareElement(before, after, element, match);
    if (!diff.sameSize) {
      findings.push({
        rule: "unintended-visual-change",
        file: fixture,
        line: null,
        message: `${element.description} changed size (${diff.sizes})`,
      });
    } else if (diff.ratio > ELEMENT_TOLERANCE) {
      findings.push({
        rule: "unintended-visual-change",
        file: fixture,
        line: null,
        message: `${element.description} changed appearance (${(diff.ratio * 100).toFixed(1)}% of its pixels)`,
      });
    } else {
      unchanged += 1;
    }
  }
  const removed = before.elements.filter((element) => !afterByKey.has(element.key)).length;
  const appeared = after.elements.filter((element) => !beforeKeys.has(element.key)).length;
  const edited = Math.min(removed, appeared);
  return { unchanged, edited, added: appeared - edited, removed: removed - edited };
}

/**
 * Gate 4. Renders every harness fixture whose import closure contains a changed file, before and after the diff, in
 * headless Chrome with the network blocked. An element the diff kept (same tag, text and identifying attributes)
 * must be pixel-identical within tolerance; new or edited elements are reported, not failed. The pre-diff render
 * must also match the committed baseline, which proves the harness itself is deterministic.
 */
export async function visualRegressionGate(ctx: GateContext, options: VisualOptions): Promise<GateResult> {
  if (options.priorFailure) {
    return skip(["static gates failed, so the diff was never executed"], "not run: blocked upstream");
  }
  const baselineDir = options.baselineDir ?? BASELINE_DIR;
  const changed = new Set(ctx.changeSet.files.filter((file) => !file.escapesRoot).map((file) => file.path));
  const fixtures = findFixtures(ctx.root);
  const affected: string[] = [];
  const covered = new Set<string>();
  for (const fixture of fixtures) {
    const source = ctx.projects.post.getSourceFile(join(ctx.root, fixture));
    if (!source) {
      continue;
    }
    const closure = importClosure(source, ctx.root);
    for (const path of closure) {
      covered.add(path);
    }
    if ([...changed].some((path) => closure.has(path))) {
      affected.push(fixture);
    }
  }

  const uncovered: string[] = [];
  for (const change of ctx.changeSet.files) {
    if (change.escapesRoot || change.kind === "delete" || !isCodeFile(change.path) || covered.has(change.path)) {
      continue;
    }
    const source = ctx.projects.post.getSourceFile(join(ctx.root, change.path));
    const rendersSomething = source
      ? topLevelSymbols(source, ctx.root, ctx.config.risk).some((symbol) => symbol.kind === "component")
      : false;
    if (rendersSomething) {
      uncovered.push(change.path);
    }
  }
  if (affected.length === 0) {
    return uncovered.length > 0
      ? skip(
          uncovered.map((path) => `no harness fixture renders ${path}`),
          "not verified: no fixture covers the change",
        )
      : {
          gate: "visual-regression",
          status: "pass",
          pass: true,
          summary: "no rendered surface affected",
          reasons: [],
          findings: [],
        };
  }

  let browser: Awaited<ReturnType<typeof launchBrowser>>;
  try {
    browser = await launchBrowser();
  } catch (error) {
    if (error instanceof BrowserUnavailableError) {
      return skip([error.message], "not run: no browser");
    }
    throw error;
  }

  const overrides = new Map<string, string>();
  for (const change of ctx.changeSet.files) {
    if (!change.escapesRoot && change.after !== null) {
      overrides.set(change.path, change.after);
    }
  }
  const findings: Finding[] = [];
  const notes: string[] = [];
  const missingBaselines: string[] = [];
  let unchanged = 0;
  let edited = 0;
  let added = 0;
  let removed = 0;
  try {
    for (const fixture of affected) {
      const before = await renderFixture(browser, ctx.root, fixture);
      let after: Rendering;
      try {
        after = await renderFixture(browser, ctx.root, fixture, overrides);
      } catch (error) {
        const message = error instanceof Error ? (error.message.split("\n")[1] ?? error.message) : String(error);
        findings.push({
          rule: "render-error",
          file: fixture,
          line: null,
          message: `post-diff build or render failed: ${message.trim()}`,
        });
        continue;
      }
      for (const error of after.errors) {
        findings.push({ rule: "render-error", file: fixture, line: null, message: `post-diff render error: ${error}` });
      }
      const baselinePath = join(baselineDir, baselineName(fixture));
      if (existsSync(baselinePath)) {
        const drift = comparePngs(PNG.sync.read(readFileSync(baselinePath)), before.image);
        if (!drift.sameSize || drift.ratio > BASELINE_TOLERANCE) {
          findings.push({
            rule: "baseline-drift",
            file: fixture,
            line: null,
            message: `pre-diff render no longer matches committed baseline (${drift.sameSize ? `${(drift.ratio * 100).toFixed(2)}%` : drift.sizes}); run pnpm baseline after review`,
          });
        }
      } else {
        missingBaselines.push(fixture);
      }
      const counts = compareRenderings(fixture, before, after, findings);
      unchanged += counts.unchanged;
      edited += counts.edited;
      added += counts.added;
      removed += counts.removed;
      notes.push(
        `${fixture}: ${counts.unchanged} kept elements identical, ${counts.edited} edited, ${counts.added} added, ${counts.removed} removed`,
      );
    }
  } finally {
    await browser.close();
  }

  if (findings.length > 0) {
    return {
      gate: "visual-regression",
      status: "fail",
      pass: false,
      summary: `${findings.length} unintended change${findings.length === 1 ? "" : "s"}`,
      reasons: findings.map(formatFinding),
      findings,
    };
  }
  if (missingBaselines.length > 0 || uncovered.length > 0) {
    return skip(
      [
        ...missingBaselines.map((fixture) => `no committed baseline for ${fixture}; run pnpm baseline`),
        ...uncovered.map((path) => `no harness fixture renders ${path}`),
        ...notes,
      ],
      "not fully verified",
    );
  }
  return {
    gate: "visual-regression",
    status: "pass",
    pass: true,
    summary: `${unchanged} existing elements unchanged, ${edited} edited, ${added} added${removed > 0 ? `, ${removed} removed` : ""}`,
    reasons: notes,
    findings: [],
  };
}
