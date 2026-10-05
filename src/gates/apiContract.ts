import { basename, join } from "node:path";
import { DEFAULT_HTTP_OPTIONS, extractHttpCalls, type HttpCall, responseFieldsRead } from "../analysis/http";
import {
  type Contract,
  checkShape,
  deref,
  literalValue,
  matchOperation,
  schemaName,
  shapeOfType,
  validateLiteral,
} from "../analysis/openapi";
import { isCodeFile } from "../analysis/project";
import { type Finding, type GateContext, type GateResult, resultFromFindings } from "./types";

function label(call: HttpCall): string {
  return `${call.method} ${call.url ?? "<dynamic url>"}`;
}

function checkCall(call: HttpCall, contract: Contract): { findings: Finding[]; verified: string | null } {
  const findings: Finding[] = [];
  const add = (rule: string, message: string, line = call.line) =>
    findings.push({ rule, file: call.file, line, message });
  const fields = responseFieldsRead(call.responseBindings);

  if (call.method === "UNKNOWN") {
    add("dynamic-method", `HTTP method not statically known: ${call.snippet}`);
    return { findings, verified: null };
  }
  const match = matchOperation(contract, call.method, call.url, call.basePrefixed);
  if (!match.ok) {
    if (match.reason === "dynamic-url") {
      add("dynamic-url", `URL not statically resolvable, cannot verify: ${call.snippet}`);
    } else if (match.reason === "method-not-allowed") {
      add(
        "method-not-allowed",
        `${call.method} not allowed on ${match.path} (contract allows ${match.allowed.join(", ")})`,
      );
    } else {
      const where =
        match.reason === "outside-base"
          ? `outside the contract's server base ${contract.basePath}`
          : `no such path in ${basename(contract.sourceFile)}`;
      add("hallucinated-endpoint", `hallucinated endpoint: ${label(call)} (${where})`);
    }
    if (fields.length > 0) {
      const names = [...new Set(fields.map((field) => field.name))].join(", ");
      add(
        "unverifiable-response",
        `response fields read with no schema to check them against: ${names}`,
        fields[0]?.line,
      );
    }
    return { findings, verified: null };
  }

  const { operation } = match;
  if (call.body) {
    if (!operation.requestSchema) {
      add("unexpected-body", `${operation.method} ${operation.path} declares no request body but one is sent`);
    } else {
      const shape = shapeOfType(call.body.getType(), call.body);
      for (const problem of checkShape(contract, shape, operation.requestSchema, "body")) {
        add("request-body", `${problem} (${schemaName(operation.requestSchema)})`);
      }
      const literal = literalValue(call.body);
      if (literal) {
        for (const problem of validateLiteral(contract, operation.requestSchema, literal.value)) {
          add("request-body", `ajv: ${problem} (${schemaName(operation.requestSchema)})`);
        }
      }
    }
  }

  let response = deref(contract, operation.responseSchema);
  if (response?.type === "array") {
    response = deref(contract, response.items);
  }
  const declared = response?.properties ?? {};
  for (const field of fields) {
    if (!(field.name in declared)) {
      add(
        "response-field",
        `response field ${field.name} is not in ${schemaName(operation.responseSchema)}`,
        field.line,
      );
    }
  }
  return { findings, verified: findings.length === 0 ? `${operation.method} ${operation.path} matches schema` : null };
}

/**
 * Gate 3. Extracts every HTTP call from the changed files (raw, via apiClient, or via a wrapper in src/api) and
 * validates it against the OpenAPI contract: the path exists, the method is allowed, the request body matches the
 * schema, and every response field the code reads is declared. A hallucinated endpoint fails here.
 */
export function apiContractGate(ctx: GateContext): GateResult {
  const options = { root: ctx.root, ...DEFAULT_HTTP_OPTIONS };
  const findings: Finding[] = [];
  const verified = new Set<string>();
  for (const change of ctx.changeSet.files) {
    if (change.escapesRoot || change.kind === "delete" || !isCodeFile(change.path)) {
      continue;
    }
    const sourceFile = ctx.projects.post.getSourceFile(join(ctx.root, change.path));
    if (!sourceFile) {
      continue;
    }
    for (const call of extractHttpCalls(sourceFile, options)) {
      // The sanctioned client's own fetch is the transport, not a call: its URL is a parameter, and every real
      // call through it is validated at its call site.
      if (change.path === options.apiClientModule && call.via === "fetch") {
        continue;
      }
      const result = checkCall(call, ctx.contract);
      findings.push(...result.findings);
      if (result.verified) {
        verified.add(result.verified);
      }
    }
  }
  const unique = findings.filter(
    (finding, index) =>
      findings.findIndex((other) => other.message === finding.message && other.line === finding.line) === index,
  );
  const summary = verified.size > 0 ? [...verified].join(", ") : "no HTTP calls in changed files";
  return resultFromFindings("api-contract", unique, summary);
}
