import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch";
import type { SliceConfig } from "../config";
import { incidentsFor } from "../ingest/docs";
import type { Embedder } from "../ingest/embed";
import { exceedsClearance } from "../ingest/graph";
import type { GraphNode, GraphStore } from "../stores/graph";
import type { VectorHit, VectorStore } from "../stores/vectors";

export interface ContextFile {
  path: string;
  /** Full source for files the implementer may edit; exported signatures for everything else. */
  mode: "full" | "signature";
  content: string;
}

export interface RetrievedContext {
  query: string;
  seeds: VectorHit[];
  target: GraphNode | undefined;
  components: GraphNode[];
  functions: GraphNode[];
  contracts: GraphNode[];
  owners: GraphNode[];
  /** Financial code nodes outside the write scope. Reachable in the graph, deliberately not shown to the model. */
  withheld: GraphNode[];
  /** Incident write-ups and know-how interviews that mention the target: what broke last time it changed. */
  documents: GraphNode[];
  /** The text of those documents, for the implementer prompt. */
  history: string[];
  files: ContextFile[];
}

export interface ResolveDeps {
  root: string;
  graph: GraphStore;
  vectors: VectorStore;
  embedder: Embedder;
  config: SliceConfig;
  topK?: number;
}

function signatureOf(source: string): string {
  return source
    .split("\n")
    .filter((line) => /^(export |import |\s*\/\*\*|\s*\*)/.test(line))
    .map((line) => line.replace(/\{\s*$/, "{ ... }"))
    .join("\n");
}

/**
 * Graph-resolved retrieval. Vector search only nominates seeds; the context is then assembled by walking the code
 * graph from the best writable component: what it renders, what renders it, what it calls, the endpoints those calls
 * depend on, and who owns it. Nodes above the agent's clearance and outside its write scope are withheld.
 */
export async function resolveContext(query: string, deps: ResolveDeps): Promise<RetrievedContext> {
  const { graph, config } = deps;
  const writable = config.allowlist.allow.map((glob) => picomatch(glob));
  const denied = config.allowlist.deny.map((glob) => picomatch(glob));
  const canWrite = (path: string) => writable.some((test) => test(path)) && !denied.some((test) => test(path));

  const seeds = await deps.vectors.query(await deps.embedder.embedQuery(query), deps.topK ?? 16);
  let target: GraphNode | undefined;
  // Pass 1: code hits only. Pass 2: documents (incidents, ADRs) resolve to the components they mention. Code wins
  // because an incident write-up mentions many components; it is evidence, not a pointer.
  for (const pass of ["code", "documents"] as const) {
    for (const hit of seeds) {
      const node = await graph.getNode(hit.nodeId);
      if (!node || (node.label === "Document") !== (pass === "documents")) {
        continue;
      }
      let candidates: GraphNode[] = [node];
      if (node.label === "Module") {
        // Type and constant chunks hang off their module; resolve them to the component that module defines.
        candidates = await graph.findNodes({ label: "Component", sourceFile: node.sourceFile });
      } else if (node.label === "Document") {
        candidates = (await graph.neighbors(node.id, { direction: "out", types: ["MENTIONS"] })).map(
          ({ node: mentioned }) => mentioned,
        );
      }
      target = candidates.find((candidate) => candidate.label === "Component" && canWrite(candidate.sourceFile));
      if (target) {
        break;
      }
    }
    if (target) {
      break;
    }
  }

  const collected = new Map<string, GraphNode>();
  const add = (node: GraphNode) => collected.set(node.id, node);
  if (target) {
    add(target);
    const neighbours = await graph.neighbors(target.id, { direction: "both", types: ["RENDERS"] });
    for (const { node } of neighbours) {
      add(node);
    }
    for (const { node: parent } of neighbours.filter(({ edge }) => edge.to === target?.id)) {
      for (const { node: sibling } of await graph.neighbors(parent.id, { direction: "out", types: ["RENDERS"] })) {
        add(sibling);
      }
    }
    const callers = [target, ...neighbours.filter(({ edge }) => edge.from === target?.id).map(({ node }) => node)];
    for (const caller of callers) {
      for (const { node: fn } of await graph.neighbors(caller.id, { direction: "out", types: ["CALLS"] })) {
        add(fn);
        for (const { node: endpoint } of await graph.neighbors(fn.id, {
          direction: "out",
          types: ["DEPENDS_ON_ENDPOINT"],
        })) {
          add(endpoint);
        }
      }
    }
    for (const { node: owner } of await graph.neighbors(`module:${target.sourceFile}`, {
      direction: "out",
      types: ["OWNED_BY"],
    })) {
      add(owner);
    }
  }

  const all = [...collected.values()];
  const isCode = (node: GraphNode) => node.label === "Component" || node.label === "Function";
  const withheld = all.filter(
    (node) =>
      isCode(node) && exceedsClearance(node.sensitivity, config.risk.agentClearance) && !canWrite(node.sourceFile),
  );
  const shared = all.filter((node) => !withheld.includes(node));

  const files: ContextFile[] = [];
  const seenFiles = new Set<string>();
  for (const node of shared.filter(isCode)) {
    if (seenFiles.has(node.sourceFile)) {
      continue;
    }
    seenFiles.add(node.sourceFile);
    const source = readFileSync(join(deps.root, node.sourceFile), "utf8");
    const full = node.id === target?.id;
    files.push({
      path: node.sourceFile,
      mode: full ? "full" : "signature",
      content: full ? source : signatureOf(source),
    });
  }

  const documents = target ? await incidentsFor(graph, target.id) : [];
  return {
    query,
    seeds,
    target,
    components: shared.filter((node) => node.label === "Component"),
    functions: shared.filter((node) => node.label === "Function"),
    contracts: shared.filter((node) => node.label === "Endpoint"),
    owners: shared.filter((node) => node.label === "Owner"),
    withheld,
    documents,
    history: documents.map((document) => {
      const path = join(deps.root, document.sourceFile);
      return existsSync(path) ? `--- ${document.sourceFile}\n${readFileSync(path, "utf8")}` : `--- ${document.name}`;
    }),
    files,
  };
}
