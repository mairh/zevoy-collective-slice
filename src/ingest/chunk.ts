import type { Sensitivity } from "../config";
import { nodeId } from "./graph";
import type { ParsedModule } from "./parse";

/** A retrieval unit. Always a whole declaration, never a token window, and always pinned to a graph node. */
export interface Chunk {
  id: string;
  nodeId: string;
  sourceFile: string;
  symbol: string;
  kind: string;
  startLine: number;
  endLine: number;
  text: string;
  sensitivity: Sensitivity;
}

/**
 * Chunks on symbol boundaries. A function, component, type or constant is one chunk with its graph node id
 * attached, so a vector hit can be expanded through the graph instead of read in isolation.
 */
export function chunkModules(modules: ParsedModule[], sensitivityOf: (nodeId: string) => Sensitivity): Chunk[] {
  const chunks: Chunk[] = [];
  for (const module of modules) {
    const moduleNode = nodeId.module(module.path);
    for (const symbol of module.symbols) {
      const owningNode =
        symbol.kind === "component" || symbol.kind === "function"
          ? nodeId.symbol(symbol.kind, module.path, symbol.name)
          : moduleNode;
      chunks.push({
        id: `${module.path}#${symbol.name}`,
        nodeId: owningNode,
        sourceFile: module.path,
        symbol: symbol.name,
        kind: symbol.kind,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        text: `// ${module.path} :: ${symbol.kind} ${symbol.name}\n${symbol.text}`,
        sensitivity: sensitivityOf(owningNode),
      });
    }
  }
  return chunks;
}
