import { join } from "node:path";
import picomatch from "picomatch";
import { Node, type SourceFile, SyntaxKind } from "ts-morph";
import { logicFingerprint } from "../analysis/fingerprint";
import { DEFAULT_HTTP_OPTIONS, extractHttpCalls } from "../analysis/http";
import { matchOperation } from "../analysis/openapi";
import { isCodeFile } from "../analysis/project";
import { ownerOf, parseCodeowners } from "../ingest/graph";
import { topLevelSymbols } from "../ingest/parse";
import type { FileChange } from "../workspace/changeSet";
import type { GateContext } from "./types";

export type RiskTier = "LOW" | "MEDIUM" | "HIGH";

export interface RiskSignal {
  tier: RiskTier;
  rule: string;
  message: string;
  file: string;
  line: number | null;
}

export interface Approver {
  handle: string;
  rule: string;
}

export interface RiskAssessment {
  tier: RiskTier;
  signals: RiskSignal[];
  /** Named humans who must approve. Always populated for HIGH. */
  approvers: Approver[];
  /** Only LOW with every gate passing may deploy without a human. */
  autonomousEligible: boolean;
}

const ORDER: Record<RiskTier, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

function intersects(start: number, end: number, lines: Set<number>): boolean {
  for (const line of lines) {
    if (line >= start && line <= end) {
      return true;
    }
  }
  return false;
}

function onLines(node: Node, lines: Set<number>): boolean {
  return intersects(node.getStartLineNumber(), node.getEndLineNumber(), lines);
}

/** Identifiers that sit on a changed line, for field-level rules. */
function changedIdentifiers(sourceFile: SourceFile, lines: Set<number>): Node[] {
  return sourceFile
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .filter(
      (identifier) =>
        lines.has(identifier.getStartLineNumber()) && !identifier.getFirstAncestorByKind(SyntaxKind.ImportDeclaration),
    );
}

function sideSignals(
  sourceFile: SourceFile,
  file: string,
  lines: Set<number>,
  ctx: GateContext,
  side: "added" | "removed",
): RiskSignal[] {
  const risk = ctx.config.risk;
  const signals: RiskSignal[] = [];
  const verb = side === "added" ? "introduced" : "removed";

  for (const symbol of topLevelSymbols(sourceFile, ctx.root, risk)) {
    if (!intersects(symbol.startLine, symbol.endLine, lines)) {
      continue;
    }
    if (symbol.kind === "component" && symbol.moneyRendering) {
      signals.push({
        tier: "HIGH",
        rule: "money-rendering",
        message: `money-rendering component touched: ${symbol.name}`,
        file,
        line: symbol.startLine,
      });
    }
  }

  for (const element of [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxElement),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ]) {
    const opening = Node.isJsxElement(element) ? element.getOpeningElement() : element;
    if (opening.getTagNameNode().getText() !== "form") {
      continue;
    }
    const onSubmit = opening.getAttribute("onSubmit");
    if (!onSubmit || !Node.isJsxAttribute(onSubmit)) {
      continue;
    }
    const initializer = onSubmit.getInitializer();
    const handlerName =
      initializer && Node.isJsxExpression(initializer) ? initializer.getExpression()?.getText() : undefined;
    const handler = handlerName
      ? (sourceFile.getFunction(handlerName) ??
        sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration).find((fn) => fn.getName() === handlerName))
      : undefined;
    if (onLines(element, lines) || (handler && onLines(handler, lines))) {
      signals.push({
        tier: "HIGH",
        rule: "submit-form",
        message: `form with submit handler touched: <form onSubmit={${handlerName ?? "..."}}> lines ${element.getStartLineNumber()}-${element.getEndLineNumber()}`,
        file,
        line: element.getStartLineNumber(),
      });
    }
  }

  const amountPattern = new RegExp(risk.amountFieldPattern, "i");
  const identifiers = changedIdentifiers(sourceFile, lines);
  const amountFields = [
    ...new Set(identifiers.map((node) => node.getText()).filter((name) => amountPattern.test(name))),
  ];
  if (amountFields.length > 0) {
    signals.push({
      tier: "HIGH",
      rule: "amount-field",
      message: `amount/balance field ${verb}: ${amountFields.join(", ")}`,
      file,
      line: identifiers.find((node) => amountPattern.test(node.getText()))?.getStartLineNumber() ?? null,
    });
  }

  const permissionCalls = sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter(
      (call) => lines.has(call.getStartLineNumber()) && risk.permissionCallees.includes(call.getExpression().getText()),
    );
  for (const call of permissionCalls) {
    signals.push({
      tier: "HIGH",
      rule: "permission-check",
      message: `permission check ${verb}: ${call.getText()}`,
      file,
      line: call.getStartLineNumber(),
    });
  }

  const stateHooks = sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter(
      (call) => lines.has(call.getStartLineNumber()) && /^(useState|useReducer)$/.test(call.getExpression().getText()),
    );
  for (const hook of stateHooks) {
    const holder = hook.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    signals.push({
      tier: "MEDIUM",
      rule: "state-shape",
      message: `component state ${verb}: ${holder?.getNameNode().getText() ?? hook.getText()}`,
      file,
      line: hook.getStartLineNumber(),
    });
  }
  for (const declaration of [...sourceFile.getInterfaces(), ...sourceFile.getTypeAliases()]) {
    if (onLines(declaration, lines)) {
      signals.push({
        tier: "MEDIUM",
        rule: "state-shape",
        message: `type shape changed: ${declaration.getName()}`,
        file,
        line: declaration.getStartLineNumber(),
      });
    }
  }
  return signals;
}

function newApiCalls(
  change: FileChange,
  pre: SourceFile | undefined,
  post: SourceFile,
  ctx: GateContext,
): RiskSignal[] {
  const options = { root: ctx.root, ...DEFAULT_HTTP_OPTIONS };
  const keyOf = (method: string, url: string | null) => `${method} ${url ?? "?"}`;
  const before = new Map<string, number>();
  for (const call of pre ? extractHttpCalls(pre, options) : []) {
    const key = keyOf(call.method, call.url);
    before.set(key, (before.get(key) ?? 0) + 1);
  }
  const signals: RiskSignal[] = [];
  for (const call of extractHttpCalls(post, options)) {
    const key = keyOf(call.method, call.url);
    const remaining = before.get(key) ?? 0;
    if (remaining > 0) {
      before.set(key, remaining - 1);
      continue;
    }
    const match = matchOperation(ctx.contract, call.method, call.url, call.basePrefixed);
    const financial = match.ok && match.operation.sensitivity === "financial";
    signals.push({
      tier: financial ? "HIGH" : "MEDIUM",
      rule: "new-api-call",
      message: match.ok
        ? `new API call to existing ${financial ? "financial " : ""}endpoint: ${match.operation.method} ${match.operation.path}`
        : `new API call: ${key}`,
      file: change.path,
      line: call.line,
    });
  }
  return signals;
}

/** One signal per rule per file: amount fields are unioned, other rules keep their first (post-diff) occurrence. */
function mergeSignals(signals: RiskSignal[]): RiskSignal[] {
  const merged = new Map<string, RiskSignal>();
  const fields = new Map<string, Set<string>>();
  for (const signal of signals) {
    const key =
      signal.rule === "state-shape" || signal.rule === "new-api-call"
        ? `${signal.rule}|${signal.message}`
        : `${signal.rule}|${signal.file}`;
    if (signal.rule === "amount-field") {
      const names = fields.get(key) ?? new Set<string>();
      for (const name of signal.message.split(": ")[1]?.split(", ") ?? []) {
        names.add(name);
      }
      fields.set(key, names);
    }
    if (!merged.has(key)) {
      merged.set(key, signal);
    }
  }
  return [...merged.entries()].map(([key, signal]) => {
    const names = fields.get(key);
    return names ? { ...signal, message: `amount/balance fields touched: ${[...names].join(", ")}` } : signal;
  });
}

/**
 * Classifies a diff as LOW, MEDIUM or HIGH from the AST and the graph. Deterministic; no model proposes or adjusts it.
 * HIGH: money-rendering component, form submit handler, amount/balance field, permission check, financial path,
 * or a new call to an endpoint the contract marks x-sensitivity: financial.
 * MEDIUM: new API call, state or type shape change, any logic change. LOW: copy, styling or layout only.
 */
export async function classifyRisk(ctx: GateContext): Promise<RiskAssessment> {
  const risk = ctx.config.risk;
  const signals: RiskSignal[] = [];
  const financial = risk.financialPaths.map((glob) => picomatch(glob));
  const surfaces: string[] = [];

  for (const change of ctx.changeSet.files) {
    if (change.escapesRoot) {
      signals.push({
        tier: "HIGH",
        rule: "path-escape",
        message: "diff writes outside the repo",
        file: change.path,
        line: null,
      });
      continue;
    }
    if (financial.some((test) => test(change.path))) {
      signals.push({
        tier: "HIGH",
        rule: "financial-path",
        message: `financial module touched: ${change.path}`,
        file: change.path,
        line: null,
      });
    }
    if (!isCodeFile(change.path)) {
      signals.push({
        tier: "MEDIUM",
        rule: "non-code",
        message: `non-code file changed: ${change.path}`,
        file: change.path,
        line: null,
      });
      continue;
    }
    const absolute = join(ctx.root, change.path);
    const pre = change.kind === "add" ? undefined : ctx.projects.pre.getSourceFile(absolute);
    const post = change.kind === "delete" ? undefined : ctx.projects.post.getSourceFile(absolute);
    if (post) {
      signals.push(...sideSignals(post, change.path, change.addedLines, ctx, "added"));
    }
    if (pre) {
      signals.push(...sideSignals(pre, change.path, change.removedLines, ctx, "removed"));
    }
    if (post) {
      signals.push(...newApiCalls(change, pre, post, ctx));
    }
    const samePresentationOnly =
      pre !== undefined &&
      post !== undefined &&
      logicFingerprint(pre, risk.presentationalAttributes) === logicFingerprint(post, risk.presentationalAttributes);
    if (!samePresentationOnly) {
      signals.push({
        tier: "MEDIUM",
        rule: "logic-change",
        message:
          change.kind === "modify"
            ? "logic changed (not copy, styling or layout only)"
            : `file ${change.kind === "add" ? "added" : "deleted"}`,
        file: change.path,
        line: null,
      });
    }
    for (const node of await ctx.graph.findNodes({ label: "Component", sourceFile: change.path })) {
      surfaces.push(`${node.name} (${node.sensitivity})`);
    }
  }

  const unique = mergeSignals(signals);
  const tier = unique.reduce<RiskTier>(
    (current, signal) => (ORDER[signal.tier] > ORDER[current] ? signal.tier : current),
    "LOW",
  );
  if (tier === "LOW") {
    unique.push({
      tier: "LOW",
      rule: "presentation-only",
      message: `copy/styling/layout only: logic fingerprint unchanged; surface ${surfaces.join(", ") || "non-transactional"}`,
      file: ctx.changeSet.files[0]?.path ?? "-",
      line: null,
    });
  }

  const rules = parseCodeowners(ctx.root);
  const approvers: Approver[] = [];
  for (const change of ctx.changeSet.files) {
    const rule = ownerOf(change.path, rules);
    for (const handle of rule?.owners ?? []) {
      if (!approvers.some((approver) => approver.handle === handle)) {
        approvers.push({ handle, rule: `CODEOWNERS ${rule?.pattern ?? ""}` });
      }
    }
  }

  return {
    tier,
    signals: unique.sort((a, b) => ORDER[b.tier] - ORDER[a.tier]),
    approvers: tier === "HIGH" ? approvers : [],
    autonomousEligible: tier === "LOW",
  };
}
