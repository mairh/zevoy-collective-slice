import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch";
import { DEFAULT_HTTP_OPTIONS } from "../analysis/http";
import { type Contract, matchOperation } from "../analysis/openapi";
import type { RiskConfig, Sensitivity } from "../config";
import type { GraphEdge, GraphNode, GraphStore, NodeLabel } from "../stores/graph";
import type { ParsedModule, ParsedSymbol } from "./parse";

export const nodeId = {
  module: (path: string) => `module:${path}`,
  symbol: (kind: "component" | "function", path: string, name: string) => `${kind}:${path}#${name}`,
  endpoint: (method: string, path: string) => `endpoint:${method} ${path}`,
  owner: (handle: string) => `owner:${handle}`,
};

export interface OwnerRule {
  pattern: string;
  owners: string[];
  test: (path: string) => boolean;
}

/** Parses a CODEOWNERS file. Later rules win, as on GitHub. */
export function parseCodeowners(root: string): OwnerRule[] {
  const candidates = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"].map((file) => join(root, file));
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) {
    return [];
  }
  const rules: OwnerRule[] = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern || owners.length === 0) {
      continue;
    }
    const anchored = pattern.startsWith("/");
    let glob = pattern.replace(/^\//, "");
    if (glob.endsWith("/")) {
      glob = `${glob}**`;
    }
    if (!anchored) {
      glob = `**/${glob}`;
    }
    rules.push({ pattern, owners, test: picomatch(glob, { dot: true }) });
  }
  return rules;
}

/** The CODEOWNERS rule that governs a path (last match wins). */
export function ownerOf(path: string, rules: OwnerRule[]): OwnerRule | undefined {
  return [...rules].reverse().find((rule) => rule.test(path));
}

/** Current commit of the target repo, or "uncommitted" when there is no git history. */
export function commitShaOf(root: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "uncommitted";
  }
}

function pathSensitivity(path: string, risk: RiskConfig): Sensitivity {
  if (risk.financialPaths.some((glob) => picomatch(glob)(path))) {
    return "financial";
  }
  if (risk.internalPaths.some((glob) => picomatch(glob)(path))) {
    return "internal";
  }
  return "public";
}

const RANK: Record<Sensitivity, number> = { public: 0, internal: 1, financial: 2 };

/** The higher of two sensitivities. */
export function maxSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return RANK[a] >= RANK[b] ? a : b;
}

/** True when a node's sensitivity is above the given clearance. */
export function exceedsClearance(sensitivity: Sensitivity, clearance: Sensitivity): boolean {
  return RANK[sensitivity] > RANK[clearance];
}

function symbolNodeId(symbol: ParsedSymbol, path: string): string | null {
  if (symbol.kind === "component" || symbol.kind === "function") {
    return nodeId.symbol(symbol.kind, path, symbol.name);
  }
  return null;
}

export interface BuildGraphInput {
  root: string;
  modules: ParsedModule[];
  contract: Contract | undefined;
  risk: RiskConfig;
}

/**
 * Turns parsed modules into nodes and edges and writes them to the store.
 * Nodes: Component, Module, Function, Endpoint, Owner. Edges: CALLS, RENDERS, IMPORTS, DEPENDS_ON_ENDPOINT, OWNED_BY.
 */
export async function buildGraph(store: GraphStore, input: BuildGraphInput): Promise<void> {
  const { root, modules, contract, risk } = input;
  const commitSha = commitShaOf(root);
  const ingestedAt = new Date().toISOString();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const node = (
    id: string,
    label: NodeLabel,
    name: string,
    sourceFile: string,
    sensitivity: Sensitivity,
    props: GraphNode["props"] = {},
  ): GraphNode => ({ id, label, name, sourceFile, commitSha, ingestedAt, sensitivity, props });

  const knownSymbols = new Map<string, string>();
  for (const module of modules) {
    for (const symbol of module.symbols) {
      const id = symbolNodeId(symbol, module.path);
      if (id) {
        knownSymbols.set(`${module.path}#${symbol.name}`, id);
      }
    }
  }

  if (contract) {
    for (const operation of contract.operations) {
      nodes.push(
        node(
          nodeId.endpoint(operation.method, operation.path),
          "Endpoint",
          `${operation.method} ${operation.path}`,
          contract.sourceFile,
          operation.sensitivity,
          {
            operationId: operation.operationId,
            inContract: true,
          },
        ),
      );
    }
  }

  const ownerRules = parseCodeowners(root);
  const owners = new Set<string>();

  for (const module of modules) {
    const moduleId = nodeId.module(module.path);
    let moduleSensitivity = pathSensitivity(module.path, risk);
    for (const symbol of module.symbols) {
      const id = symbolNodeId(symbol, module.path);
      if (!id) {
        continue;
      }
      const label: NodeLabel = symbol.kind === "component" ? "Component" : "Function";
      const sensitivity =
        symbol.kind === "component" && symbol.moneyRendering ? "financial" : pathSensitivity(module.path, risk);
      moduleSensitivity = maxSensitivity(moduleSensitivity, sensitivity);
      nodes.push(
        node(id, label, symbol.name, module.path, sensitivity, {
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          exported: symbol.exported,
          moneyRendering: symbol.moneyRendering,
          hasSubmitHandler: symbol.hasSubmitHandler,
          permissionCheck: symbol.permissionCheck,
          amountFields: symbol.amountFields,
        }),
      );
      for (const target of symbol.renders) {
        const to = knownSymbols.get(`${target.file}#${target.name}`);
        if (to) {
          edges.push({ type: "RENDERS", from: id, to });
        }
      }
      for (const target of symbol.calls) {
        const to = knownSymbols.get(`${target.file}#${target.name}`);
        if (to?.startsWith("function:")) {
          edges.push({ type: "CALLS", from: id, to });
        }
      }
    }
    const owner = ownerOf(module.path, ownerRules);
    nodes.push(
      node(moduleId, "Module", module.path, module.path, moduleSensitivity, {
        owner: owner?.owners.join(" ") ?? "",
        ownerRule: owner?.pattern ?? "",
      }),
    );
    for (const imported of module.imports) {
      if (imported.resolved) {
        edges.push({ type: "IMPORTS", from: moduleId, to: nodeId.module(imported.resolved) });
      }
    }
    for (const handle of owner?.owners ?? []) {
      owners.add(handle);
      edges.push({ type: "OWNED_BY", from: moduleId, to: nodeId.owner(handle) });
    }
    for (const call of module.httpCalls) {
      const from = call.symbol ? knownSymbols.get(`${module.path}#${call.symbol}`) : undefined;
      if (!from) {
        continue;
      }
      const match = contract ? matchOperation(contract, call.method, call.url, call.basePrefixed) : undefined;
      if (match?.ok) {
        edges.push({
          type: "DEPENDS_ON_ENDPOINT",
          from,
          to: nodeId.endpoint(match.operation.method, match.operation.path),
        });
      } else if (call.url !== null && module.path !== DEFAULT_HTTP_OPTIONS.apiClientModule) {
        const id = nodeId.endpoint(call.method, call.url);
        nodes.push(node(id, "Endpoint", `${call.method} ${call.url}`, module.path, "internal", { inContract: false }));
        edges.push({ type: "DEPENDS_ON_ENDPOINT", from, to: id });
      }
    }
  }

  for (const handle of owners) {
    nodes.push(node(nodeId.owner(handle), "Owner", handle, "CODEOWNERS", "internal"));
  }

  await store.clear();
  await store.upsertNodes(nodes);
  const ids = new Set(nodes.map((candidate) => candidate.id));
  await store.upsertEdges(edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)));
}
