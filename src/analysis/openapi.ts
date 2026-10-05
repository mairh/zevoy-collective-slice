import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { type Expression, Node, type Type } from "ts-morph";
import { parse } from "yaml";

export interface JsonSchema {
  type?: string;
  $ref?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  nullable?: boolean;
  allOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}

interface OperationObject {
  operationId?: string;
  "x-sensitivity"?: string;
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }>;
}

interface OpenApiDocument {
  servers?: { url: string }[];
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, JsonSchema> };
}

export interface ContractOperation {
  method: string;
  path: string;
  operationId: string;
  sensitivity: "public" | "internal" | "financial";
  requestSchema: JsonSchema | undefined;
  responseSchema: JsonSchema | undefined;
}

export interface Contract {
  sourceFile: string;
  basePath: string;
  operations: ContractOperation[];
  document: OpenApiDocument;
}

export type MatchResult =
  | { ok: true; operation: ContractOperation; path: string }
  | {
      ok: false;
      reason: "outside-base" | "unknown-path" | "method-not-allowed" | "dynamic-url";
      path: string | null;
      allowed: string[];
    };

const METHODS = ["get", "put", "post", "patch", "delete", "head", "options"];

/** Loads an OpenAPI 3 document and flattens it into operations. */
export function loadContract(path: string): Contract {
  const document = parse(readFileSync(path, "utf8")) as OpenApiDocument;
  const basePath = (document.servers?.[0]?.url ?? "").replace(/\/$/, "");
  const operations: ContractOperation[] = [];
  for (const [routePath, item] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      const operation = item[method] as OperationObject | undefined;
      if (!operation) {
        continue;
      }
      const success = Object.entries(operation.responses ?? {}).find(([status]) => status.startsWith("2"));
      const sensitivity = operation["x-sensitivity"];
      operations.push({
        method: method.toUpperCase(),
        path: routePath,
        operationId: operation.operationId ?? `${method} ${routePath}`,
        sensitivity: sensitivity === "financial" || sensitivity === "public" ? sensitivity : "internal",
        requestSchema: operation.requestBody?.content?.["application/json"]?.schema,
        responseSchema: success?.[1].content?.["application/json"]?.schema,
      });
    }
  }
  return { sourceFile: path, basePath, operations, document };
}

function segmentsMatch(urlPath: string, routePath: string): boolean {
  const urlSegments = urlPath.split("/").filter(Boolean);
  const routeSegments = routePath.split("/").filter(Boolean);
  if (urlSegments.length !== routeSegments.length) {
    return false;
  }
  return routeSegments.every((routeSegment, index) => {
    const urlSegment = urlSegments[index] ?? "";
    const routeIsParam = /^\{.+\}$/.test(routeSegment);
    if (urlSegment === "{param}") {
      return routeIsParam;
    }
    return routeIsParam || routeSegment === urlSegment;
  });
}

/** Matches a statically read call against the contract. Literal segments are preferred over templated ones. */
export function matchOperation(
  contract: Contract,
  method: string,
  url: string | null,
  basePrefixed: boolean,
): MatchResult {
  if (url === null) {
    return { ok: false, reason: "dynamic-url", path: null, allowed: [] };
  }
  let path = url;
  if (!basePrefixed) {
    if (/^https?:\/\//.test(url) || !(url === contract.basePath || url.startsWith(`${contract.basePath}/`))) {
      return { ok: false, reason: "outside-base", path: url, allowed: [] };
    }
    path = url.slice(contract.basePath.length) || "/";
  }
  const candidates = contract.operations
    .filter((operation) => segmentsMatch(path, operation.path))
    .sort((a, b) => (a.path.match(/\{/g)?.length ?? 0) - (b.path.match(/\{/g)?.length ?? 0));
  if (candidates.length === 0) {
    return { ok: false, reason: "unknown-path", path, allowed: [] };
  }
  const bestPath = candidates[0]?.path;
  const samePath = candidates.filter((operation) => operation.path === bestPath);
  const operation = samePath.find((candidate) => candidate.method === method);
  if (!operation) {
    return { ok: false, reason: "method-not-allowed", path, allowed: samePath.map((candidate) => candidate.method) };
  }
  return { ok: true, operation, path };
}

/** Follows `$ref` and single-element `allOf` wrappers (the OpenAPI 3.0 nullable-ref idiom). */
export function deref(contract: Contract, schema: JsonSchema | undefined): JsonSchema | undefined {
  let current = schema;
  let nullable = false;
  for (let guard = 0; current && guard < 16; guard += 1) {
    if (current.nullable === true) {
      nullable = true;
    }
    if (current.$ref) {
      const name = current.$ref.replace("#/components/schemas/", "");
      current = contract.document.components?.schemas?.[name];
      continue;
    }
    if (current.allOf?.length === 1 && current.properties === undefined) {
      current = current.allOf[0];
      continue;
    }
    break;
  }
  return current && nullable ? { ...current, nullable: true } : current;
}

/** Human name for a schema in reports. */
export function schemaName(schema: JsonSchema | undefined): string {
  if (schema?.$ref) {
    return schema.$ref.replace("#/components/schemas/", "");
  }
  return schema?.allOf?.[0]?.$ref?.replace("#/components/schemas/", "") ?? "inline schema";
}

/** Structural description of a TypeScript type, enough to compare against JSON Schema. */
export type TypeShape =
  | { kind: "string" | "number" | "boolean" | "null" | "unknown"; literal?: string | number | boolean }
  | { kind: "object"; properties: Record<string, { shape: TypeShape; optional: boolean }> }
  | { kind: "array"; items: TypeShape }
  | { kind: "union"; options: TypeShape[] };

/** Reads the static type of a body expression into a TypeShape using the type checker. */
export function shapeOfType(type: Type, location: Node, depth = 0): TypeShape {
  if (depth > 5) {
    return { kind: "unknown" };
  }
  if (type.isNull()) {
    return { kind: "null" };
  }
  if (type.isStringLiteral()) {
    return { kind: "string", literal: String(type.getLiteralValue()) };
  }
  if (type.isNumberLiteral()) {
    return { kind: "number", literal: Number(type.getLiteralValue()) };
  }
  if (type.isBooleanLiteral()) {
    return { kind: "boolean", literal: type.getText() === "true" };
  }
  if (type.isString()) {
    return { kind: "string" };
  }
  if (type.isNumber()) {
    return { kind: "number" };
  }
  if (type.isBoolean()) {
    return { kind: "boolean" };
  }
  if (type.isUnion()) {
    const options = type
      .getUnionTypes()
      .filter((option) => !option.isUndefined())
      .map((option) => shapeOfType(option, location, depth + 1));
    const booleans = options.filter((option) => option.kind === "boolean");
    const rest = options.filter((option) => option.kind !== "boolean");
    const merged = booleans.length === 2 ? [...rest, { kind: "boolean" as const }] : options;
    return merged.length === 1 && merged[0] ? merged[0] : { kind: "union", options: merged };
  }
  if (type.isArray()) {
    const element = type.getArrayElementType();
    return { kind: "array", items: element ? shapeOfType(element, location, depth + 1) : { kind: "unknown" } };
  }
  if (type.isObject()) {
    const properties: Record<string, { shape: TypeShape; optional: boolean }> = {};
    for (const property of type.getProperties()) {
      const propertyType = property.getTypeAtLocation(location);
      properties[property.getName()] = {
        shape: shapeOfType(propertyType, location, depth + 1),
        optional: property.isOptional() || propertyType.isUndefined(),
      };
    }
    return { kind: "object", properties };
  }
  return { kind: "unknown" };
}

function describeShape(shape: TypeShape): string {
  if (shape.kind === "union") {
    return shape.options.map(describeShape).join(" | ");
  }
  if (shape.kind === "array") {
    return `${describeShape(shape.items)}[]`;
  }
  return shape.kind;
}

/** Compares a TypeShape to a schema. Returns human-readable problems; empty means compatible. */
export function checkShape(
  contract: Contract,
  shape: TypeShape,
  schemaIn: JsonSchema | undefined,
  at: string,
): string[] {
  const schema = deref(contract, schemaIn);
  if (!schema) {
    return [];
  }
  if (shape.kind === "null") {
    return schema.nullable ? [] : [`${at} may be null but schema is not nullable`];
  }
  if (shape.kind === "union") {
    return shape.options.flatMap((option) => checkShape(contract, option, schema, at));
  }
  if (shape.kind === "unknown") {
    return [`${at} has a type the gate cannot verify statically`];
  }
  const schemaType = schema.type ?? (schema.properties ? "object" : undefined);
  if (shape.kind === "object") {
    if (schemaType !== "object") {
      return [`${at} is an object but schema expects ${schemaType ?? "unspecified"}`];
    }
    const problems: string[] = [];
    const declared = schema.properties ?? {};
    for (const [name, property] of Object.entries(shape.properties)) {
      const child = declared[name];
      if (!child) {
        problems.push(`field ${at}.${name} is not in the schema`);
        continue;
      }
      problems.push(...checkShape(contract, property.shape, child, `${at}.${name}`));
    }
    for (const required of schema.required ?? []) {
      const property = shape.properties[required];
      if (!property || property.optional) {
        problems.push(`required field ${at}.${required} is missing or optional`);
      }
    }
    return problems;
  }
  if (shape.kind === "array") {
    return schemaType === "array"
      ? checkShape(contract, shape.items, schema.items, `${at}[]`)
      : [`${at} is an array but schema expects ${schemaType ?? "unspecified"}`];
  }
  const compatible =
    (shape.kind === "number" && (schemaType === "number" || schemaType === "integer")) || shape.kind === schemaType;
  if (!compatible) {
    return [`${at} is ${describeShape(shape)} but schema expects ${schemaType ?? "unspecified"}`];
  }
  if (schema.enum && shape.literal !== undefined && !schema.enum.includes(shape.literal)) {
    return [
      `${at} is ${JSON.stringify(shape.literal)} but schema allows ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`,
    ];
  }
  return [];
}

/** Evaluates a body expression to a plain value when every leaf is a literal. Returns undefined otherwise. */
export function literalValue(expression: Expression): { value: unknown } | undefined {
  if (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) {
    return { value: expression.getLiteralText() };
  }
  if (Node.isNumericLiteral(expression)) {
    return { value: expression.getLiteralValue() };
  }
  if (Node.isTrueLiteral(expression) || Node.isFalseLiteral(expression)) {
    return { value: expression.getLiteralValue() };
  }
  if (Node.isNullLiteral(expression)) {
    return { value: null };
  }
  if (Node.isArrayLiteralExpression(expression)) {
    const values: unknown[] = [];
    for (const element of expression.getElements()) {
      const inner = literalValue(element);
      if (!inner) {
        return undefined;
      }
      values.push(inner.value);
    }
    return { value: values };
  }
  if (Node.isObjectLiteralExpression(expression)) {
    const out: Record<string, unknown> = {};
    for (const property of expression.getProperties()) {
      if (!Node.isPropertyAssignment(property)) {
        return undefined;
      }
      const initializer = property.getInitializer();
      const inner = initializer ? literalValue(initializer) : undefined;
      if (!inner) {
        return undefined;
      }
      out[property.getName().replace(/^["']|["']$/g, "")] = inner.value;
    }
    return { value: out };
  }
  return undefined;
}

/** Validates a literal body against the contract schema with ajv. Returns ajv's messages. */
export function validateLiteral(contract: Contract, schema: JsonSchema, value: unknown): string[] {
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    formats: { "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/ },
  });
  ajv.addSchema({ $id: "contract", components: contract.document.components ?? {} });
  const rewritten = JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"contract#/components/')) as object;
  const validate = ajv.compile(rewritten);
  if (validate(value)) {
    return [];
  }
  return (validate.errors ?? []).map((error) => `${error.instancePath || "body"} ${error.message ?? "is invalid"}`);
}
