import { readFileSync, writeFileSync } from "node:fs";
import type { Sensitivity } from "../config";

export type NodeLabel = "Component" | "Module" | "Function" | "Endpoint" | "Owner" | "Document";
export type EdgeType = "CALLS" | "RENDERS" | "IMPORTS" | "DEPENDS_ON_ENDPOINT" | "OWNED_BY" | "MENTIONS";

export const NODE_LABELS: NodeLabel[] = ["Component", "Module", "Function", "Endpoint", "Owner", "Document"];
export const EDGE_TYPES: EdgeType[] = ["CALLS", "RENDERS", "IMPORTS", "DEPENDS_ON_ENDPOINT", "OWNED_BY", "MENTIONS"];

export type PropValue = string | number | boolean | string[];

export interface GraphNode {
  id: string;
  label: NodeLabel;
  name: string;
  sourceFile: string;
  commitSha: string;
  ingestedAt: string;
  sensitivity: Sensitivity;
  props: Record<string, PropValue>;
}

export interface GraphEdge {
  type: EdgeType;
  from: string;
  to: string;
}

export interface Neighbor {
  edge: GraphEdge;
  node: GraphNode;
}

export interface GraphStats {
  nodes: Record<NodeLabel, number>;
  edges: Record<EdgeType, number>;
  totalNodes: number;
  totalEdges: number;
}

/**
 * The code-graph contract. Async on purpose: a Neo4j implementation (`MERGE (n:Component {id: $id})`,
 * `MATCH (a)-[r:RENDERS]->(b)`) must be a drop-in swap, so callers never rely on synchronous access.
 */
export interface GraphStore {
  readonly backend: string;
  clear(): Promise<void>;
  upsertNodes(nodes: GraphNode[]): Promise<void>;
  upsertEdges(edges: GraphEdge[]): Promise<void>;
  getNode(id: string): Promise<GraphNode | undefined>;
  findNodes(filter: { label?: NodeLabel; sourceFile?: string }): Promise<GraphNode[]>;
  neighbors(id: string, options: { direction: "out" | "in" | "both"; types?: EdgeType[] }): Promise<Neighbor[]>;
  stats(): Promise<GraphStats>;
}

interface Snapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** In-memory graph with adjacency indexes. Persists to a JSON snapshot so the demo and gates share one ingest. */
export class InMemoryGraphStore implements GraphStore {
  readonly backend = "in-memory";
  private nodes = new Map<string, GraphNode>();
  private edgeKeys = new Set<string>();
  private outgoing = new Map<string, GraphEdge[]>();
  private incoming = new Map<string, GraphEdge[]>();

  async clear(): Promise<void> {
    this.nodes.clear();
    this.edgeKeys.clear();
    this.outgoing.clear();
    this.incoming.clear();
  }

  async upsertNodes(nodes: GraphNode[]): Promise<void> {
    for (const node of nodes) {
      this.nodes.set(node.id, node);
    }
  }

  async upsertEdges(edges: GraphEdge[]): Promise<void> {
    for (const edge of edges) {
      const key = `${edge.type}|${edge.from}|${edge.to}`;
      if (this.edgeKeys.has(key) || edge.from === edge.to) {
        continue;
      }
      this.edgeKeys.add(key);
      this.outgoing.set(edge.from, [...(this.outgoing.get(edge.from) ?? []), edge]);
      this.incoming.set(edge.to, [...(this.incoming.get(edge.to) ?? []), edge]);
    }
  }

  async getNode(id: string): Promise<GraphNode | undefined> {
    return this.nodes.get(id);
  }

  async findNodes(filter: { label?: NodeLabel; sourceFile?: string }): Promise<GraphNode[]> {
    return [...this.nodes.values()].filter(
      (node) =>
        (filter.label === undefined || node.label === filter.label) &&
        (filter.sourceFile === undefined || node.sourceFile === filter.sourceFile),
    );
  }

  async neighbors(id: string, options: { direction: "out" | "in" | "both"; types?: EdgeType[] }): Promise<Neighbor[]> {
    const edges = [
      ...(options.direction !== "in" ? (this.outgoing.get(id) ?? []) : []),
      ...(options.direction !== "out" ? (this.incoming.get(id) ?? []) : []),
    ].filter((edge) => options.types === undefined || options.types.includes(edge.type));
    const out: Neighbor[] = [];
    for (const edge of edges) {
      const node = this.nodes.get(edge.from === id ? edge.to : edge.from);
      if (node) {
        out.push({ edge, node });
      }
    }
    return out;
  }

  async stats(): Promise<GraphStats> {
    const nodes = Object.fromEntries(NODE_LABELS.map((label) => [label, 0])) as Record<NodeLabel, number>;
    const edges = Object.fromEntries(EDGE_TYPES.map((type) => [type, 0])) as Record<EdgeType, number>;
    for (const node of this.nodes.values()) {
      nodes[node.label] += 1;
    }
    for (const list of this.outgoing.values()) {
      for (const edge of list) {
        edges[edge.type] += 1;
      }
    }
    return {
      nodes,
      edges,
      totalNodes: this.nodes.size,
      totalEdges: Object.values(edges).reduce((sum, count) => sum + count, 0),
    };
  }

  /** Writes a JSON snapshot. */
  save(path: string): void {
    const snapshot: Snapshot = { nodes: [...this.nodes.values()], edges: [...this.outgoing.values()].flat() };
    writeFileSync(path, JSON.stringify(snapshot));
  }

  /** Loads a JSON snapshot written by save(). */
  static async load(path: string): Promise<InMemoryGraphStore> {
    const snapshot = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
    const store = new InMemoryGraphStore();
    await store.upsertNodes(snapshot.nodes);
    await store.upsertEdges(snapshot.edges);
    return store;
  }
}

/** Walks edges breadth-first from a start node and returns every reachable node id, including the start. */
export async function reachable(
  store: GraphStore,
  start: string,
  options: { direction: "out" | "in"; types: EdgeType[]; maxDepth?: number },
): Promise<Set<string>> {
  const seen = new Set<string>([start]);
  let frontier = [start];
  for (let depth = 0; frontier.length > 0 && depth < (options.maxDepth ?? 32); depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const { node } of await store.neighbors(id, { direction: options.direction, types: options.types })) {
        if (!seen.has(node.id)) {
          seen.add(node.id);
          next.push(node.id);
        }
      }
    }
    frontier = next;
  }
  return seen;
}
