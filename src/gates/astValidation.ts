import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, posix } from "node:path";
import picomatch from "picomatch";
import { Node, type Project, type SourceFile, SyntaxKind } from "ts-morph";
import { isGlobalObject, normalisedAccess, resolvedCalleeName } from "../analysis/globals";
import { isCodeFile } from "../analysis/project";
import type { ForbiddenConfig } from "../config";
import { type Finding, type GateContext, type GateResult, resultFromFindings } from "./types";

export type AstRule =
  | "new-network-call"
  | "new-dependency"
  | "dynamic-evaluation"
  | "suppressed-check"
  | "banking-client-import"
  | "env-access"
  | "does-not-compile"
  | "import-escape";

interface Occurrence {
  rule: AstRule;
  key: string;
  line: number;
  message: string;
}

const LITERAL_KINDS = new Set([
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateHead,
  SyntaxKind.TemplateMiddle,
  SyntaxKind.TemplateTail,
  SyntaxKind.JsxText,
]);

const TEST_CALLERS = new Set(["it", "test", "describe", "suite", "context", "bench"]);

function compact(text: string): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > 64 ? `${flat.slice(0, 61)}...` : flat;
}

/** Package name of a bare module specifier: `@scope/pkg/sub` becomes `@scope/pkg`, `pkg/sub` becomes `pkg`. */
export function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/");
}

function isBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || builtinModules.includes(packageName(specifier));
}

function moduleSpecifiers(sourceFile: SourceFile): { specifier: string; line: number }[] {
  const out: { specifier: string; line: number }[] = [];
  for (const declaration of [...sourceFile.getImportDeclarations(), ...sourceFile.getExportDeclarations()]) {
    const specifier = declaration.getModuleSpecifierValue();
    if (specifier !== undefined) {
      out.push({ specifier, line: declaration.getStartLineNumber() });
    }
  }
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const isDynamicImport = callee.getKind() === SyntaxKind.ImportKeyword;
    if (isDynamicImport || resolvedCalleeName(callee) === "require") {
      const first = call.getArguments()[0];
      if (first && (Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first))) {
        out.push({ specifier: first.getLiteralText(), line: call.getStartLineNumber() });
      }
    }
  }
  return out;
}

function resolveRelative(importer: string, specifier: string, project: Project, root: string): string {
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier));
  for (const suffix of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const candidate = `${base}${suffix}`;
    if (project.getSourceFile(join(root, candidate)) || existsSync(join(root, candidate))) {
      return candidate;
    }
  }
  return base;
}

function collect(sourceFile: SourceFile, file: string, project: Project, ctx: GateContext): Occurrence[] {
  const forbidden: ForbiddenConfig = ctx.config.forbidden;
  const out: Occurrence[] = [];
  const network = new Set(forbidden.networkCallees);

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    // Resolved through the type checker and local aliases, so `window["fetch"]`, `self.fetch` and
    // `const f = fetch; f()` all resolve to `fetch`.
    const calleeText = resolvedCalleeName(callee) ?? callee.getText();
    const line = call.getStartLineNumber();
    const firstArg = call.getArguments()[0];
    if (network.has(calleeText) || calleeText.startsWith("axios.")) {
      out.push({
        rule: "new-network-call",
        key: `${calleeText}(${firstArg?.getText() ?? ""})`,
        line,
        message: `new network call introduced: ${compact(`${callee.getText()}(${firstArg?.getText() ?? ""})`)}`,
      });
    }
    const loadsModule = callee.getKind() === SyntaxKind.ImportKeyword || calleeText === "require";
    if (loadsModule && firstArg && !Node.isStringLiteral(firstArg) && !Node.isNoSubstitutionTemplateLiteral(firstArg)) {
      out.push({
        rule: "dynamic-evaluation",
        key: `module:${firstArg.getText()}`,
        line,
        message: `module loaded from a computed specifier: ${compact(call.getText())}`,
      });
    }
    if (calleeText === "eval" || calleeText === "Function") {
      out.push({
        rule: "dynamic-evaluation",
        key: calleeText,
        line,
        message: `dynamic evaluation: ${compact(callee.getText())}(...)`,
      });
    }
    if (
      (calleeText === "setTimeout" || calleeText === "setInterval") &&
      firstArg &&
      (Node.isStringLiteral(firstArg) || Node.isTemplateExpression(firstArg))
    ) {
      out.push({
        rule: "dynamic-evaluation",
        key: `${calleeText}:string`,
        line,
        message: `${calleeText} with a string body`,
      });
    }
    if (Node.isPropertyAccessExpression(callee)) {
      const owner = callee.getExpression().getText().split(".")[0] ?? "";
      if (forbidden.skipCalls.includes(callee.getName()) && TEST_CALLERS.has(owner)) {
        out.push({
          rule: "suppressed-check",
          key: callee.getText(),
          line,
          message: `test disabled: ${callee.getText()}(...)`,
        });
      }
    }
  }

  for (const created of sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    const name = resolvedCalleeName(created.getExpression()) ?? created.getExpression().getText();
    const line = created.getStartLineNumber();
    if (network.has(name)) {
      out.push({
        rule: "new-network-call",
        key: `new ${name}`,
        line,
        message: `new network call introduced: new ${name}(...)`,
      });
    }
    if (name === "Function") {
      out.push({ rule: "dynamic-evaluation", key: "Function", line, message: "dynamic evaluation: new Function(...)" });
    }
  }

  for (const attribute of sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
    if (attribute.getNameNode().getText() === "dangerouslySetInnerHTML") {
      out.push({
        rule: "dynamic-evaluation",
        key: "dangerouslySetInnerHTML",
        line: attribute.getStartLineNumber(),
        message: "dangerouslySetInnerHTML introduced",
      });
    }
  }

  const text = sourceFile.getFullText();
  for (const marker of forbidden.suppressionMarkers) {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const notCommentEnd = "(?:(?!\\*/)[\\s\\S])*?";
    const pattern = new RegExp(`//[^\\n]*?${escaped}|/\\*${notCommentEnd}${escaped}`, "g");
    for (const match of text.matchAll(pattern)) {
      const position = (match.index ?? 0) + match[0].lastIndexOf(marker);
      const inside = sourceFile.getDescendantAtPos(position);
      if (inside && LITERAL_KINDS.has(inside.getKind()) && inside.getStart() <= position) {
        continue;
      }
      const line = sourceFile.getLineAndColumnAtPos(position).line;
      out.push({ rule: "suppressed-check", key: marker, line, message: `check suppressed: ${marker}` });
    }
  }

  // A global looked up by a computed key (`globalThis["Web" + "Socket"]`) cannot be resolved statically, so it is
  // rejected outright rather than guessed at.
  for (const access of sourceFile.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
    const argument = access.getArgumentExpression();
    const literal = argument && (Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument));
    if (isGlobalObject(access.getExpression()) && !literal) {
      out.push({
        rule: "dynamic-evaluation",
        key: `computed-global:${access.getText()}`,
        line: access.getStartLineNumber(),
        message: `global accessed by computed key: ${compact(access.getText())}`,
      });
    }
  }

  // Reflect.get / Reflect.construct / Reflect.apply on a host object with a computed key is the same lookup in
  // call form, so it gets the same treatment.
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression().getText();
    const [target, key] = call.getArguments();
    const literal = key !== undefined && (Node.isStringLiteral(key) || Node.isNoSubstitutionTemplateLiteral(key));
    if (
      /^Reflect\.(get|construct|apply|getOwnPropertyDescriptor)$/.test(callee) &&
      target &&
      isGlobalObject(target) &&
      !literal
    ) {
      out.push({
        rule: "dynamic-evaluation",
        key: `reflect-global:${call.getText()}`,
        line: call.getStartLineNumber(),
        message: `global accessed through ${callee} with a computed key: ${compact(call.getText())}`,
      });
    }
  }

  for (const access of [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.ElementAccessExpression),
  ]) {
    const accessText = normalisedAccess(access) ?? access.getText();
    if (forbidden.envAccess.includes(accessText)) {
      const parent = access.getParent();
      const read =
        parent && (Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent))
          ? parent.getText()
          : accessText;
      out.push({
        rule: "env-access",
        key: read,
        line: access.getStartLineNumber(),
        message: `environment read introduced: ${read}`,
      });
    }
  }

  const bankingModules = forbidden.bankingClient.modules.map((glob) => picomatch(glob));
  const importerAllowed = forbidden.bankingClient.allowedImporters.includes(file);
  for (const { specifier, line } of moduleSpecifiers(sourceFile)) {
    if (isBareSpecifier(specifier)) {
      continue;
    }
    const resolved = resolveRelative(file, specifier, project, ctx.root);
    if (specifier.startsWith("/") || resolved === ".." || resolved.startsWith("../")) {
      out.push({
        rule: "import-escape",
        key: specifier,
        line,
        message: `import reaches outside the repo: ${specifier}`,
      });
      continue;
    }
    if (!importerAllowed && bankingModules.some((test) => test(resolved))) {
      out.push({
        rule: "banking-client-import",
        key: resolved,
        line,
        message: `direct banking client import: ${specifier} (only ${forbidden.bankingClient.allowedImporters.join(", ")} may import it)`,
      });
    }
  }
  return out;
}

function declaredDependencies(root: string): Set<string> {
  const path = join(root, "package.json");
  if (!existsSync(path)) {
    return new Set();
  }
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, string> | undefined>;
  return new Set(
    ["dependencies", "devDependencies", "peerDependencies"].flatMap((field) => Object.keys(manifest[field] ?? {})),
  );
}

function preImportSet(project: Project): Set<string> {
  const out = new Set<string>();
  for (const sourceFile of project.getSourceFiles()) {
    for (const { specifier } of moduleSpecifiers(sourceFile)) {
      if (isBareSpecifier(specifier)) {
        out.add(packageName(specifier));
      }
    }
  }
  return out;
}

function introduced(pre: Occurrence[], post: Occurrence[], addedLines: Set<number>): Occurrence[] {
  const budget = new Map<string, number>();
  for (const occurrence of pre) {
    const key = `${occurrence.rule}|${occurrence.key}`;
    budget.set(key, (budget.get(key) ?? 0) + 1);
  }
  const ordered = [...post].sort(
    (a, b) => Number(addedLines.has(a.line)) - Number(addedLines.has(b.line)) || a.line - b.line,
  );
  const flagged: Occurrence[] = [];
  for (const occurrence of ordered) {
    const key = `${occurrence.rule}|${occurrence.key}`;
    const remaining = budget.get(key) ?? 0;
    if (remaining > 0) {
      budget.set(key, remaining - 1);
    } else {
      flagged.push(occurrence);
    }
  }
  return flagged.sort((a, b) => a.line - b.line);
}

/** TypeScript diagnostics for one file as `code|message` keys with lines. Syntax and type errors alike. */
function diagnostics(sourceFile: SourceFile): { key: string; line: number; message: string }[] {
  return sourceFile.getPreEmitDiagnostics().map((diagnostic) => {
    const raw = diagnostic.getMessageText();
    const message = typeof raw === "string" ? raw : raw.getMessageText();
    return { key: `${diagnostic.getCode()}|${message}`, line: diagnostic.getLineNumber() ?? 1, message };
  });
}

/**
 * Gate 2. Parses every changed file before and after the diff and rejects anything the diff introduces from the
 * forbidden list: syntax or type errors, raw network calls, undeclared dependencies, dynamic evaluation, suppressed checks, direct
 * banking-client imports and environment reads. Pre-existing occurrences are not this diff's fault and are ignored.
 */
export function astValidationGate(ctx: GateContext): GateResult {
  const { pre, post } = ctx.projects;
  const declared = declaredDependencies(ctx.root);
  const alreadyImported = preImportSet(pre);
  const findings: Finding[] = [];

  for (const change of ctx.changeSet.files) {
    if (change.escapesRoot || change.kind === "delete" || !isCodeFile(change.path)) {
      continue;
    }
    const postFile = post.getSourceFile(join(ctx.root, change.path));
    if (!postFile) {
      continue;
    }
    const preFile = change.kind === "modify" ? pre.getSourceFile(join(ctx.root, change.path)) : undefined;
    const preOccurrences = preFile ? collect(preFile, change.path, pre, ctx) : [];
    const postOccurrences = collect(postFile, change.path, post, ctx);
    for (const occurrence of introduced(preOccurrences, postOccurrences, change.addedLines)) {
      findings.push({ rule: occurrence.rule, file: change.path, line: occurrence.line, message: occurrence.message });
    }
    const preDiagnostics = new Map<string, number>();
    for (const diagnostic of preFile ? diagnostics(preFile) : []) {
      preDiagnostics.set(diagnostic.key, (preDiagnostics.get(diagnostic.key) ?? 0) + 1);
    }
    for (const diagnostic of diagnostics(postFile)) {
      const remaining = preDiagnostics.get(diagnostic.key) ?? 0;
      if (remaining > 0) {
        preDiagnostics.set(diagnostic.key, remaining - 1);
        continue;
      }
      findings.push({
        rule: "does-not-compile",
        file: change.path,
        line: diagnostic.line,
        message: `does not compile: ${diagnostic.message.split("\n")[0]}`,
      });
    }
    for (const { specifier, line } of moduleSpecifiers(postFile)) {
      if (!isBareSpecifier(specifier) || isBuiltin(specifier)) {
        continue;
      }
      const name = packageName(specifier);
      if (!declared.has(name) && !alreadyImported.has(name)) {
        findings.push({
          rule: "new-dependency",
          file: change.path,
          line,
          message: `new dependency introduced: ${name} (not in package.json)`,
        });
      }
    }
  }

  const passSummary = "compiles, no new deps, no new network calls, no suppressions";
  return resultFromFindings("ast-validation", findings, passSummary);
}
