import { type Contract, type ContractOperation, deref, type JsonSchema, schemaName } from "../analysis/openapi";
import { nodeId } from "../ingest/graph";
import { type GraphNode, type GraphStore, reachable } from "../stores/graph";

export type ContractChangeKind =
  | "operation-added"
  | "operation-removed"
  | "request-property-added"
  | "request-property-removed"
  | "response-property-added"
  | "response-property-removed";

/** One structural difference between two versions of the back-end contract. */
export interface ContractChange {
  kind: ContractChangeKind;
  method: string;
  path: string;
  operationId: string;
  /** Schema that owns the property, for property-level changes. */
  schema?: string;
  property?: string;
  /** True when existing callers can break: removed operations, removed properties, newly required request fields. */
  breaking: boolean;
  description: string;
}

/** What one contract change reaches in the current code graph. Endpoint-level: callers of the changed operation. */
export interface Impact {
  change: ContractChange;
  endpointId: string;
  /** Functions that call the endpoint, plus functions that call those (hooks wrapping a client function). */
  functions: GraphNode[];
  /** Components that call an affected function, or the endpoint directly. */
  components: GraphNode[];
  /** Components that render an affected component, up to two levels up. */
  renderedBy: GraphNode[];
  /** CODEOWNERS handles of the modules holding the affected functions and components. */
  owners: string[];
  /** Deterministic change-request text for the implementer, or null when nothing in the code consumes the change. */
  changeRequest: string | null;
}

const key = (operation: { method: string; path: string }) => `${operation.method} ${operation.path}`;

/** Top-level property names of a schema; arrays are read through their items. */
function propertiesOf(contract: Contract, schema: JsonSchema | undefined): { name: string; properties: Set<string> } {
  const resolved = deref(contract, schema);
  const target = resolved?.type === "array" ? deref(contract, resolved.items) : resolved;
  const name = resolved?.type === "array" ? schemaName(resolved.items) : schemaName(schema);
  return { name, properties: new Set(Object.keys(target?.properties ?? {})) };
}

function requiredOf(contract: Contract, schema: JsonSchema | undefined): Set<string> {
  return new Set(deref(contract, schema)?.required ?? []);
}

function propertyChanges(
  side: "request" | "response",
  before: { contract: Contract; operation: ContractOperation },
  after: { contract: Contract; operation: ContractOperation },
): ContractChange[] {
  const pick = (operation: ContractOperation) =>
    side === "request" ? operation.requestSchema : operation.responseSchema;
  const old = propertiesOf(before.contract, pick(before.operation));
  const next = propertiesOf(after.contract, pick(after.operation));
  const nextRequired = requiredOf(after.contract, pick(after.operation));
  const { method, path, operationId } = after.operation;
  const changes: ContractChange[] = [];
  for (const property of [...old.properties].sort()) {
    if (!next.properties.has(property)) {
      changes.push({
        kind: `${side}-property-removed`,
        method,
        path,
        operationId,
        schema: old.name,
        property,
        breaking: true,
        description: `${side} property ${old.name}.${property} removed from ${method} ${path}`,
      });
    }
  }
  for (const property of [...next.properties].sort()) {
    if (!old.properties.has(property)) {
      const breaking = side === "request" && nextRequired.has(property);
      changes.push({
        kind: `${side}-property-added`,
        method,
        path,
        operationId,
        schema: next.name,
        property,
        breaking,
        description: `${breaking ? "required " : ""}${side} property ${next.name}.${property} added to ${method} ${path}`,
      });
    }
  }
  return changes;
}

/** Diffs two contracts: operations added or removed, and top-level request/response properties per operation. */
export function diffContracts(before: Contract, after: Contract): ContractChange[] {
  const oldOperations = new Map(before.operations.map((operation) => [key(operation), operation]));
  const newOperations = new Map(after.operations.map((operation) => [key(operation), operation]));
  const changes: ContractChange[] = [];
  for (const [id, operation] of oldOperations) {
    const next = newOperations.get(id);
    if (!next) {
      changes.push({
        kind: "operation-removed",
        method: operation.method,
        path: operation.path,
        operationId: operation.operationId,
        breaking: true,
        description: `${id} (${operation.operationId}) removed`,
      });
      continue;
    }
    changes.push(
      ...propertyChanges("request", { contract: before, operation }, { contract: after, operation: next }),
      ...propertyChanges("response", { contract: before, operation }, { contract: after, operation: next }),
    );
  }
  for (const [id, operation] of newOperations) {
    if (!oldOperations.has(id)) {
      changes.push({
        kind: "operation-added",
        method: operation.method,
        path: operation.path,
        operationId: operation.operationId,
        breaking: false,
        description: `${id} (${operation.operationId}, ${operation.sensitivity}) added`,
      });
    }
  }
  return changes;
}

const byName = (a: GraphNode, b: GraphNode) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

async function nodesOf(graph: GraphStore, ids: Iterable<string>): Promise<GraphNode[]> {
  const nodes: GraphNode[] = [];
  for (const id of ids) {
    const node = await graph.getNode(id);
    if (node) {
      nodes.push(node);
    }
  }
  return nodes.sort(byName);
}

/** An added operation under the changed path whose last segment names the removed property (transactionLimit -> /limits). */
function replacementFor(change: ContractChange, changes: ContractChange[]): ContractChange | undefined {
  const property = change.property?.toLowerCase() ?? "";
  return changes.find((candidate) => {
    if (candidate.kind !== "operation-added" || !candidate.path.startsWith(`${change.path}/`)) {
      return false;
    }
    const segment = candidate.path.split("/").pop()?.replace(/s$/, "").toLowerCase() ?? "";
    return segment !== "" && property.includes(segment);
  });
}

function changeRequestFor(
  change: ContractChange,
  changes: ContractChange[],
  functions: GraphNode[],
  components: GraphNode[],
): string | null {
  if (!change.breaking || functions.length + components.length === 0) {
    return null;
  }
  const consumers = (components.length > 0 ? components : functions).map((node) => node.name).join(", ");
  const endpoint = `${change.method} ${change.path}`;
  if (change.kind === "operation-removed") {
    const via = functions.map((node) => node.name).join(", ");
    return `Remove the ${endpoint} dependency from ${consumers}${via ? ` (via ${via})` : ""}: the endpoint is removed in the next back-end release`;
  }
  const field = `${change.schema}.${change.property}`;
  if (change.kind === "request-property-removed") {
    const replacement = replacementFor(change, changes);
    return replacement
      ? `Migrate ${consumers} off ${field} to ${replacement.method} ${replacement.path}`
      : `Stop sending ${field} from ${consumers}: ${endpoint} no longer accepts it`;
  }
  if (change.kind === "response-property-removed") {
    return `Stop reading ${field} in ${consumers}: ${endpoint} no longer returns it`;
  }
  return `Send the newly required ${field} from ${consumers} on ${endpoint}`;
}

/**
 * Walks the code graph in reverse from each changed endpoint: Endpoint <-DEPENDS_ON_ENDPOINT- Function <-CALLS-
 * Component <-RENDERS- parents (depth 2), plus OWNED_BY owners of the affected modules. Deterministic; no model.
 * Reach is endpoint-level: it names every caller of the changed operation, not proof that a caller uses the property.
 */
export async function impactOf(changes: ContractChange[], graph: GraphStore): Promise<Impact[]> {
  const impacts: Impact[] = [];
  for (const change of changes) {
    const endpointId = nodeId.endpoint(change.method, change.path);
    const direct = (await graph.getNode(endpointId))
      ? await graph.neighbors(endpointId, { direction: "in", types: ["DEPENDS_ON_ENDPOINT"] })
      : [];
    const callers = new Set<string>();
    for (const { node } of direct) {
      for (const id of await reachable(graph, node.id, { direction: "in", types: ["CALLS"], maxDepth: 3 })) {
        callers.add(id);
      }
    }
    const reached = await nodesOf(graph, callers);
    const functions = reached.filter((node) => node.label === "Function");
    const components = reached.filter((node) => node.label === "Component");
    const parents = new Set<string>();
    for (const component of components) {
      for (const id of await reachable(graph, component.id, { direction: "in", types: ["RENDERS"], maxDepth: 2 })) {
        if (!callers.has(id)) {
          parents.add(id);
        }
      }
    }
    const owners = new Set<string>();
    for (const file of new Set([...functions, ...components].map((node) => node.sourceFile))) {
      for (const { node } of await graph.neighbors(nodeId.module(file), { direction: "out", types: ["OWNED_BY"] })) {
        owners.add(node.name);
      }
    }
    impacts.push({
      change,
      endpointId,
      functions,
      components,
      renderedBy: await nodesOf(graph, parents),
      owners: [...owners].sort(),
      changeRequest: changeRequestFor(change, changes, functions, components),
    });
  }
  return impacts;
}
