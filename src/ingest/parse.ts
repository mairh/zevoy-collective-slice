import { Node, type Project, type SourceFile, SyntaxKind } from "ts-morph";
import { DEFAULT_HTTP_OPTIONS, declarationOf, extractHttpCalls } from "../analysis/http";
import { isCodeFile, relativePath } from "../analysis/project";
import type { RiskConfig } from "../config";

export type SymbolKind = "component" | "function" | "type" | "const";

export interface SymbolRef {
  file: string;
  name: string;
}

/** A top-level declaration: the unit of both graph nodes and retrieval chunks. */
export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  exported: boolean;
  startLine: number;
  endLine: number;
  text: string;
  /** Components this symbol renders, resolved through imports. */
  renders: SymbolRef[];
  /** Functions this symbol calls, resolved through imports. */
  calls: SymbolRef[];
  moneyRendering: boolean;
  hasSubmitHandler: boolean;
  permissionCheck: boolean;
  amountFields: string[];
}

export interface ParsedHttpCall {
  symbol: string | null;
  method: string;
  url: string | null;
  basePrefixed: boolean;
  line: number;
}

export interface ParsedModule {
  path: string;
  imports: { specifier: string; resolved: string | null }[];
  symbols: ParsedSymbol[];
  httpCalls: ParsedHttpCall[];
}

const EXCLUDED = [/\.fixture\.tsx?$/, /\.test\.tsx?$/, /\.spec\.tsx?$/, /\.stories\.tsx?$/, /(^|\/)node_modules\//];

/** True for files the graph should contain. Harness fixtures and tests are not product code. */
export function isGraphFile(path: string): boolean {
  return isCodeFile(path) && !EXCLUDED.some((pattern) => pattern.test(path));
}

function isPascalCase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

function resolveRef(identifier: Node, root: string): SymbolRef | null {
  const declaration = declarationOf(identifier);
  if (!declaration) {
    return null;
  }
  const file = relativePath(root, declaration.getSourceFile());
  if (file.startsWith("/") || file.includes("node_modules/")) {
    return null;
  }
  if (Node.isFunctionDeclaration(declaration) || Node.isVariableDeclaration(declaration)) {
    const name = declaration.getName();
    return name ? { file, name } : null;
  }
  return null;
}

function containsJsx(node: Node): boolean {
  return (
    node.getFirstDescendant(
      (child) => Node.isJsxElement(child) || Node.isJsxSelfClosingElement(child) || Node.isJsxFragment(child),
    ) !== undefined
  );
}

/** Facts about a region of code that both the graph and the risk classifier care about. */
export function analyseRegion(node: Node, root: string, risk: RiskConfig) {
  const renders: SymbolRef[] = [];
  const renderedNames: string[] = [];
  for (const tag of [
    ...node.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...node.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ]) {
    const tagName = tag.getTagNameNode();
    if (Node.isIdentifier(tagName) && isPascalCase(tagName.getText())) {
      renderedNames.push(tagName.getText());
      const ref = resolveRef(tagName, root);
      if (ref) {
        renders.push(ref);
      }
    }
  }
  const calls: SymbolRef[] = [];
  const calledNames: string[] = [];
  for (const call of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (Node.isIdentifier(callee)) {
      calledNames.push(callee.getText());
      const ref = resolveRef(callee, root);
      if (ref) {
        calls.push(ref);
      }
    }
  }
  const forms = node
    .getDescendants()
    .filter(
      (child) =>
        (Node.isJsxOpeningElement(child) || Node.isJsxSelfClosingElement(child)) &&
        child.getTagNameNode().getText() === "form" &&
        child
          .getAttributes()
          .some((attribute) => Node.isJsxAttribute(attribute) && attribute.getNameNode().getText() === "onSubmit"),
    );
  const amountPattern = new RegExp(risk.amountFieldPattern, "i");
  const amountFields = new Set<string>();
  for (const identifier of node.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const text = identifier.getText();
    if (amountPattern.test(text)) {
      amountFields.add(text);
    }
  }
  return {
    renders,
    calls,
    moneyRendering:
      renderedNames.some((name) => risk.moneyComponents.includes(name)) ||
      calledNames.some((name) => risk.moneyFormatters.includes(name)),
    hasSubmitHandler: forms.length > 0,
    permissionCheck: calledNames.some((name) => risk.permissionCallees.includes(name)),
    amountFields: [...amountFields],
  };
}

/** Top-level declarations of one file with their render/call/risk facts. */
export function topLevelSymbols(sourceFile: SourceFile, root: string, risk: RiskConfig): ParsedSymbol[] {
  const out: ParsedSymbol[] = [];
  const push = (name: string, kind: SymbolKind, node: Node, exported: boolean) => {
    const facts = kind === "component" || kind === "function" ? analyseRegion(node, root, risk) : undefined;
    out.push({
      name,
      kind,
      exported,
      startLine: node.getStartLineNumber(),
      endLine: node.getEndLineNumber(),
      text: node.getFullText().trim(),
      renders: facts?.renders ?? [],
      calls: facts?.calls ?? [],
      moneyRendering: facts?.moneyRendering ?? false,
      hasSubmitHandler: facts?.hasSubmitHandler ?? false,
      permissionCheck: facts?.permissionCheck ?? false,
      amountFields: facts?.amountFields ?? [],
    });
  };
  for (const statement of sourceFile.getStatements()) {
    if (Node.isFunctionDeclaration(statement)) {
      const name = statement.getName() ?? "default";
      const kind = isPascalCase(name) && containsJsx(statement) ? "component" : "function";
      push(name, kind, statement, statement.isExported());
    } else if (Node.isVariableStatement(statement)) {
      for (const declaration of statement.getDeclarations()) {
        const initializer = declaration.getInitializer();
        const isFunction = initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer));
        const name = declaration.getName();
        const kind: SymbolKind = isFunction
          ? isPascalCase(name) && containsJsx(declaration)
            ? "component"
            : "function"
          : "const";
        push(name, kind, statement, statement.isExported());
      }
    } else if (Node.isClassDeclaration(statement)) {
      push(statement.getName() ?? "default", "const", statement, statement.isExported());
    } else if (
      Node.isInterfaceDeclaration(statement) ||
      Node.isTypeAliasDeclaration(statement) ||
      Node.isEnumDeclaration(statement)
    ) {
      push(statement.getName(), "type", statement, statement.isExported());
    }
  }
  return out;
}

function enclosingSymbol(node: Node): string | null {
  const statement = node.getFirstAncestor((ancestor) => Node.isSourceFile(ancestor.getParent() ?? ancestor));
  if (!statement) {
    return null;
  }
  if (Node.isFunctionDeclaration(statement) || Node.isClassDeclaration(statement)) {
    return statement.getName() ?? null;
  }
  if (Node.isVariableStatement(statement)) {
    return statement.getDeclarations()[0]?.getName() ?? null;
  }
  return null;
}

/** Walks every product source file with ts-morph and extracts modules, symbols, imports and HTTP calls. */
export function parseRepo(project: Project, root: string, risk: RiskConfig): ParsedModule[] {
  const modules: ParsedModule[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    const path = relativePath(root, sourceFile);
    if (path.startsWith("/") || !isGraphFile(path)) {
      continue;
    }
    const imports = sourceFile.getImportDeclarations().map((declaration) => {
      // The compiler's own resolution, so tsconfig path aliases (`@/components/...`) resolve like relative imports.
      const target = declaration.getModuleSpecifierSourceFile();
      const resolved = target ? relativePath(root, target) : null;
      return {
        specifier: declaration.getModuleSpecifierValue(),
        resolved: resolved && !resolved.startsWith("/") && !resolved.includes("node_modules/") ? resolved : null,
      };
    });
    const httpCalls = extractHttpCalls(sourceFile, { root, ...DEFAULT_HTTP_OPTIONS })
      .filter((call) => call.via !== "wrapper")
      .map((call) => ({
        symbol: enclosingSymbol(call.node),
        method: call.method,
        url: call.url,
        basePrefixed: call.basePrefixed,
        line: call.line,
      }));
    modules.push({ path, imports, symbols: topLevelSymbols(sourceFile, root, risk), httpCalls });
  }
  return modules.sort((a, b) => a.path.localeCompare(b.path));
}
