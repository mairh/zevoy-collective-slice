import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Contract, loadContract } from "../analysis/openapi";
import { loadProject } from "../analysis/project";
import { type SliceConfig, STATE_DIR } from "../config";
import { type GraphStats, InMemoryGraphStore } from "../stores/graph";
import { SqliteVecStore, type VectorStore } from "../stores/vectors";
import { type Chunk, chunkModules } from "./chunk";
import { chunkDocs, linkDocs, parseDocs } from "./docs";
import { type Embedder, selectEmbedder } from "./embed";
import { buildGraph, commitShaOf } from "./graph";
import { type ParsedModule, parseRepo } from "./parse";

export interface IngestOptions {
  root: string;
  config: SliceConfig;
  contractPath?: string;
  embedder?: "auto" | "ollama" | "hash";
  stateDir?: string;
}

export interface IngestResult {
  root: string;
  commitSha: string;
  modules: ParsedModule[];
  chunks: Chunk[];
  documents: number;
  graph: InMemoryGraphStore;
  vectors: VectorStore;
  embedder: Embedder;
  contract: Contract | undefined;
  stats: GraphStats;
  durationMs: number;
}

/** Parse, build the graph, link docs, chunk on symbol and heading boundaries, embed, index. One pass, all local. */
export async function ingest(options: IngestOptions): Promise<IngestResult> {
  const started = performance.now();
  const stateDir = options.stateDir ?? STATE_DIR;
  mkdirSync(stateDir, { recursive: true });
  const contract = options.contractPath ? loadContract(options.contractPath) : undefined;
  const project = loadProject(options.root);
  const modules = parseRepo(project, options.root, options.config.risk);

  const graph = new InMemoryGraphStore();
  await buildGraph(graph, { root: options.root, modules, contract, risk: options.config.risk });
  const docs = parseDocs(options.root);
  await linkDocs(docs, graph, commitShaOf(options.root));
  graph.save(join(stateDir, "graph.json"));

  const sensitivity = new Map((await graph.findNodes({})).map((node) => [node.id, node.sensitivity]));
  const chunks = [...chunkModules(modules, (id) => sensitivity.get(id) ?? "internal"), ...chunkDocs(docs)];

  const embedder = await selectEmbedder(options.embedder ?? "auto");
  const vectors = await embedder.embedDocuments(chunks.map((chunk) => chunk.text));
  const store = await SqliteVecStore.open(join(stateDir, "index.sqlite"));
  await store.reset(embedder.dimensions);
  await store.upsert(chunks, vectors);

  return {
    root: options.root,
    commitSha: commitShaOf(options.root),
    modules,
    chunks,
    documents: docs.length,
    graph,
    vectors: store,
    embedder,
    contract,
    stats: await graph.stats(),
    durationMs: Math.round(performance.now() - started),
  };
}
