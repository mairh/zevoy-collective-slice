import picomatch from "picomatch";
import {
  type CallExpression,
  type Expression,
  type Identifier,
  Node,
  type ObjectLiteralExpression,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import { resolvedCalleeName } from "./globals";
import { relativePath } from "./project";

export type HttpVia = "fetch" | "axios" | "apiClient" | "wrapper";

/** One HTTP call found statically in a source file. */
export interface HttpCall {
  file: string;
  line: number;
  via: HttpVia;
  /** What the code calls: `fetch`, `apiClient.patch`, `updateCardSettings`. */
  callee: string;
  /** Upper-case HTTP method, or "UNKNOWN" when it cannot be read statically. */
  method: string;
  /** Path as written, with interpolations replaced by `{param}` and the query string dropped. Null when not static. */
  url: string | null;
  /** True when the path is relative to the contract's server base (it went through apiClient). */
  basePrefixed: boolean;
  /** The request body expression, resolved to the call site for wrapper calls. */
  body: Expression | undefined;
  /** Identifiers bound to the parsed JSON response. */
  responseBindings: Identifier[];
  /** Short source excerpt for reports. */
  snippet: string;
  /** The call expression at the site being analysed (the wrapper call for wrapper calls). */
  node: CallExpression;
}

export interface HttpExtractionOptions {
  root: string;
  /** Repo-relative path of the sanctioned API client module. */
  apiClientModule: string;
  /** Exported name of the API client object. */
  apiClientExport: string;
  /** Globs for modules whose exported functions wrap apiClient calls. */
  wrapperModules: string[];
}

export const DEFAULT_HTTP_OPTIONS: Omit<HttpExtractionOptions, "root"> = {
  apiClientModule: "src/api/client.ts",
  apiClientExport: "apiClient",
  wrapperModules: ["src/api/**"],
};

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

function skipParens(node: Node | undefined): Node | undefined {
  let current = node;
  while (current && Node.isParenthesizedExpression(current)) {
    current = current.getParent();
  }
  return current;
}

/** Resolves an identifier through import aliases to its first declaration. */
export function declarationOf(node: Node): Node | undefined {
  const symbol = node.getSymbol();
  if (!symbol) {
    return undefined;
  }
  const target = symbol.isAlias() ? (symbol.getAliasedSymbol() ?? symbol) : symbol;
  return target.getDeclarations()[0];
}

/** Reads a URL expression statically. Template interpolations become `{param}`; anything dynamic returns null. */
export function staticUrl(expression: Node | undefined): string | null {
  if (!expression) {
    return null;
  }
  let raw: string | null = null;
  if (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) {
    raw = expression.getLiteralText();
  } else if (Node.isTemplateExpression(expression)) {
    const parts = [expression.getHead().getLiteralText()];
    for (const span of expression.getTemplateSpans()) {
      parts.push("{param}", span.getLiteral().getLiteralText());
    }
    raw = parts.join("");
  }
  if (raw === null) {
    return null;
  }
  return raw.split("?")[0] ?? raw;
}

function objectProperty(literal: ObjectLiteralExpression, name: string): Expression | undefined {
  const property = literal.getProperty(name);
  if (property && Node.isPropertyAssignment(property)) {
    return property.getInitializer();
  }
  if (property && Node.isShorthandPropertyAssignment(property)) {
    return property.getNameNode();
  }
  return undefined;
}

function unwrapJsonStringify(expression: Expression | undefined): Expression | undefined {
  if (expression && Node.isCallExpression(expression) && expression.getExpression().getText() === "JSON.stringify") {
    const first = expression.getArguments()[0];
    return first && Node.isExpression(first) ? first : expression;
  }
  return expression;
}

/** Identifiers that receive the settled value of a promise-producing expression. */
function settledBindings(expression: Node): Identifier[] {
  const parent = skipParens(expression.getParent());
  if (parent && Node.isAwaitExpression(parent)) {
    const holder = skipParens(parent.getParent());
    if (holder && Node.isVariableDeclaration(holder)) {
      const name = holder.getNameNode();
      return Node.isIdentifier(name) ? [name] : [];
    }
    return [];
  }
  if (parent && Node.isPropertyAccessExpression(parent) && parent.getName() === "then") {
    const thenCall = parent.getParent();
    if (thenCall && Node.isCallExpression(thenCall)) {
      const callback = thenCall.getArguments()[0];
      if (callback && (Node.isArrowFunction(callback) || Node.isFunctionExpression(callback))) {
        const name = callback.getParameters()[0]?.getNameNode();
        return name && Node.isIdentifier(name) ? [name] : [];
      }
    }
  }
  return [];
}

/** For fetch: follow `res` to `res.json()` and return whatever the parsed JSON is bound to. */
function jsonBindings(fetchCall: CallExpression): Identifier[] {
  const out: Identifier[] = [];
  for (const response of settledBindings(fetchCall)) {
    const callback = response.getFirstAncestor((ancestor) => Node.isArrowFunction(ancestor));
    const thenCall = callback?.getParent();
    if (callback && Node.isArrowFunction(callback) && thenCall && Node.isCallExpression(thenCall)) {
      const body = callback.getBody();
      if (Node.isCallExpression(body) && body.getExpression().getText() === `${response.getText()}.json`) {
        out.push(...settledBindings(thenCall));
        continue;
      }
    }
    for (const reference of response.findReferencesAsNodes()) {
      const access = reference.getParent();
      if (access && Node.isPropertyAccessExpression(access) && access.getName() === "json") {
        const jsonCall = access.getParent();
        if (jsonCall && Node.isCallExpression(jsonCall)) {
          out.push(...settledBindings(jsonCall));
        }
      }
    }
  }
  return out;
}

function snippetOf(call: CallExpression): string {
  const text = call.getText().replace(/\s+/g, " ");
  return text.length > 72 ? `${text.slice(0, 69)}...` : text;
}

function isApiClientReference(expression: Node, options: HttpExtractionOptions): boolean {
  if (!Node.isIdentifier(expression)) {
    return false;
  }
  const declaration = declarationOf(expression);
  if (!declaration) {
    return false;
  }
  const file = relativePath(options.root, declaration.getSourceFile());
  return file === options.apiClientModule && Node.isVariableDeclaration(declaration)
    ? declaration.getName() === options.apiClientExport
    : false;
}

function directCall(call: CallExpression, file: string, options: HttpExtractionOptions): HttpCall | null {
  const callee = call.getExpression();
  const args = call.getArguments();
  const line = call.getStartLineNumber();
  const calleeText = callee.getText();
  const resolved = resolvedCalleeName(callee);

  if (resolved === "fetch") {
    const init = args[1];
    let method = "GET";
    let body: Expression | undefined;
    if (init && Node.isObjectLiteralExpression(init)) {
      const methodNode = objectProperty(init, "method");
      if (methodNode) {
        method =
          Node.isStringLiteral(methodNode) || Node.isNoSubstitutionTemplateLiteral(methodNode)
            ? methodNode.getLiteralText().toUpperCase()
            : "UNKNOWN";
      }
      body = unwrapJsonStringify(objectProperty(init, "body"));
    }
    return {
      file,
      line,
      via: "fetch",
      callee: "fetch",
      method,
      url: staticUrl(args[0]),
      basePrefixed: false,
      body,
      responseBindings: jsonBindings(call),
      snippet: snippetOf(call),
      node: call,
    };
  }

  if (Node.isPropertyAccessExpression(callee)) {
    const name = callee.getName();
    const target = callee.getExpression();
    if ((resolvedCalleeName(target) ?? target.getText()) === "axios" && HTTP_METHODS.has(name)) {
      const bodyArg = args[1];
      return {
        file,
        line,
        via: "axios",
        callee: calleeText,
        method: name.toUpperCase(),
        url: staticUrl(args[0]),
        basePrefixed: false,
        body: bodyArg && Node.isExpression(bodyArg) ? bodyArg : undefined,
        responseBindings: [],
        snippet: snippetOf(call),
        node: call,
      };
    }
    if (HTTP_METHODS.has(name) && isApiClientReference(target, options)) {
      const bodyArg = args[1];
      return {
        file,
        line,
        via: "apiClient",
        callee: calleeText,
        method: name.toUpperCase(),
        url: staticUrl(args[0]),
        basePrefixed: true,
        body: bodyArg && Node.isExpression(bodyArg) ? bodyArg : undefined,
        responseBindings: settledBindings(call),
        snippet: snippetOf(call),
        node: call,
      };
    }
  }
  return null;
}

function wrapperCalls(call: CallExpression, file: string, options: HttpExtractionOptions): HttpCall[] {
  const callee = call.getExpression();
  if (!Node.isIdentifier(callee)) {
    return [];
  }
  const declaration = declarationOf(callee);
  if (!declaration) {
    return [];
  }
  const declarationFile = relativePath(options.root, declaration.getSourceFile());
  const isWrapperModule = options.wrapperModules.some((glob) => picomatch(glob)(declarationFile));
  if (!isWrapperModule || declarationFile === options.apiClientModule || declarationFile === file) {
    return [];
  }
  const fn = Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : declaration;
  if (!fn || !(Node.isFunctionDeclaration(fn) || Node.isArrowFunction(fn) || Node.isFunctionExpression(fn))) {
    return [];
  }
  const parameters = fn.getParameters();
  const out: HttpCall[] = [];
  for (const inner of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const resolved = directCall(inner, declarationFile, options);
    if (!resolved) {
      continue;
    }
    let body = resolved.body;
    if (body && Node.isIdentifier(body)) {
      const index = parameters.findIndex((parameter) => parameter.getName() === body?.getText());
      const callSiteArg = index >= 0 ? call.getArguments()[index] : undefined;
      body = callSiteArg && Node.isExpression(callSiteArg) ? callSiteArg : body;
    }
    out.push({
      ...resolved,
      file,
      line: call.getStartLineNumber(),
      via: "wrapper",
      callee: callee.getText(),
      body,
      responseBindings: settledBindings(call),
      snippet: snippetOf(call),
      node: call,
    });
  }
  return out;
}

/**
 * Finds every HTTP call in a file: raw fetch/axios, apiClient methods, and calls to wrapper functions in
 * src/api/** (resolved through the type checker into the apiClient call they make, with the body mapped back
 * to the call-site argument).
 */
export function extractHttpCalls(sourceFile: SourceFile, options: HttpExtractionOptions): HttpCall[] {
  const file = relativePath(options.root, sourceFile);
  const out: HttpCall[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const direct = directCall(call, file, options);
    if (direct) {
      out.push(direct);
      continue;
    }
    out.push(...wrapperCalls(call, file, options));
  }
  return out;
}

/** Property names read from identifiers bound to a response. Handles `data.x` and `const { x } = data`. */
export function responseFieldsRead(bindings: Identifier[]): { name: string; line: number }[] {
  const fields: { name: string; line: number }[] = [];
  for (const binding of bindings) {
    for (const reference of binding.findReferencesAsNodes()) {
      if (reference === binding || reference.getSourceFile() !== binding.getSourceFile()) {
        continue;
      }
      const parent = reference.getParent();
      if (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === reference) {
        fields.push({ name: parent.getName(), line: parent.getStartLineNumber() });
      }
      if (parent && Node.isVariableDeclaration(parent) && parent.getInitializer() === reference) {
        const pattern = parent.getNameNode();
        if (Node.isObjectBindingPattern(pattern)) {
          for (const element of pattern.getElements()) {
            const key = element.getPropertyNameNode()?.getText() ?? element.getName();
            fields.push({ name: key, line: element.getStartLineNumber() });
          }
        }
      }
    }
  }
  return fields;
}
