import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Sensitivity } from "../config";
import type { GraphEdge, GraphNode, GraphStore, NodeLabel } from "../stores/graph";
import type { Chunk } from "./chunk";

export type DocKind = "adr" | "incident" | "know-how" | "doc";

/** One `## ` section of a document. The text before the first `## ` heading is a section named after the title. */
export interface DocSection {
  heading: string;
  startLine: number;
  endLine: number;
  text: string;
}

/** A markdown document from `docs/` with its front matter read. */
export interface ParsedDoc {
  path: string;
  title: string;
  kind: DocKind;
  date: string;
  sensitivity: Sensitivity;
  frontMatter: Record<string, string>;
  text: string;
  sections: DocSection[];
}

const KINDS: DocKind[] = ["adr", "incident", "know-how"];
const SENSITIVITIES: Sensitivity[] = ["public", "internal", "financial"];
const LINKABLE: NodeLabel[] = ["Component", "Function", "Endpoint", "Owner"];

/** Graph node id for a document. */
export function documentNodeId(path: string): string {
  return `document:${path}`;
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => join(dir, entry))
    .sort();
}

/** Reads `key: value` lines between `---` fences at the top of the file. Returns the values and the body start line. */
function readFrontMatter(lines: string[]): { values: Record<string, string>; bodyStart: number } {
  const values: Record<string, string> = {};
  if (lines[0]?.trim() !== "---") {
    return { values, bodyStart: 0 };
  }
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "---") {
      return { values, bodyStart: index + 1 };
    }
    const match = /^([\w-]+):\s*(.*)$/.exec(line);
    if (match?.[1]) {
      values[match[1]] = (match[2] ?? "").trim();
    }
  }
  return { values: {}, bodyStart: 0 };
}

function toSections(lines: string[], bodyStart: number, title: string): DocSection[] {
  const sections: DocSection[] = [];
  let heading = title;
  let start = bodyStart;
  const flush = (end: number) => {
    const text = lines.slice(start, end).join("\n").trim();
    if (text !== "") {
      sections.push({ heading, startLine: start + 1, endLine: end, text });
    }
  };
  for (let index = bodyStart; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("## ")) {
      flush(index);
      heading = line.slice(3).trim();
      start = index;
    }
  }
  flush(lines.length);
  return sections;
}

/**
 * Reads every `docs/**\/*.md` under a repo root. Sections are cut on `## ` headings, never on token windows,
 * so an incident's root cause or an interview answer stays one retrievable unit. Returns [] when there is no docs/.
 */
export function parseDocs(root: string): ParsedDoc[] {
  const docsDir = join(root, "docs");
  if (!existsSync(docsDir)) {
    return [];
  }
  return markdownFiles(docsDir).map((file) => {
    const path = relative(root, file).split(sep).join("/");
    const lines = readFileSync(file, "utf8").split("\n");
    const { values, bodyStart } = readFrontMatter(lines);
    const title =
      values.title ??
      lines
        .find((line) => line.startsWith("# "))
        ?.slice(2)
        .trim() ??
      path;
    const kind = KINDS.find((candidate) => candidate === values.kind) ?? "doc";
    const sensitivity = SENSITIVITIES.find((candidate) => candidate === values.sensitivity) ?? "internal";
    return {
      path,
      title,
      kind,
      date: values.date ?? "",
      sensitivity,
      frontMatter: values,
      text: lines.slice(bodyStart).join("\n"),
      sections: toSections(lines, bodyStart, title),
    };
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word matcher for a graph node's name as it would be written in prose. */
function mentionPattern(node: GraphNode): RegExp {
  const name = escapeRegExp(node.name);
  if (node.label === "Endpoint") {
    return new RegExp(`(?<![\\w/])${name}(?![\\w/{])`);
  }
  if (node.label === "Owner") {
    return new RegExp(`(?<![\\w.])${name}(?!\\w)`);
  }
  return new RegExp(`\\b${name}\\b`);
}

/**
 * Writes a Document node per doc and MENTIONS edges to every Component, Function, Endpoint and Owner the doc names:
 * component and function names as whole words, endpoints as `METHOD /path`, owners by handle.
 */
export async function linkDocs(docs: ParsedDoc[], graph: GraphStore, commitSha = "uncommitted"): Promise<void> {
  const ingestedAt = new Date().toISOString();
  const targets = (await graph.findNodes({})).filter((node) => LINKABLE.includes(node.label));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const doc of docs) {
    const id = documentNodeId(doc.path);
    nodes.push({
      id,
      label: "Document",
      name: doc.title,
      sourceFile: doc.path,
      commitSha,
      ingestedAt,
      sensitivity: doc.sensitivity,
      props: { kind: doc.kind, date: doc.date },
    });
    for (const target of targets) {
      // Very short names ("get", "use") would match ordinary prose; they never become mention edges.
      if (target.name.length >= 4 && mentionPattern(target).test(doc.text)) {
        edges.push({ type: "MENTIONS", from: id, to: target.id });
      }
    }
  }
  await graph.upsertNodes(nodes);
  await graph.upsertEdges(edges);
}

/** One chunk per doc section, pinned to the document's graph node so a hit expands to what the doc mentions. */
export function chunkDocs(docs: ParsedDoc[]): Chunk[] {
  return docs.flatMap((doc) =>
    doc.sections.map((section, index) => ({
      id: `${doc.path}#${index}`,
      nodeId: documentNodeId(doc.path),
      sourceFile: doc.path,
      symbol: section.heading,
      kind: doc.kind,
      startLine: section.startLine,
      endLine: section.endLine,
      text: `<!-- ${doc.path} :: ${doc.kind} "${doc.title}" (${doc.date}) -->\n${section.text}`,
      sensitivity: doc.sensitivity,
    })),
  );
}

/**
 * Incident write-ups and know-how interviews that mention a node, newest first: "what broke last time this changed".
 */
export async function incidentsFor(graph: GraphStore, nodeId: string): Promise<GraphNode[]> {
  const mentions = await graph.neighbors(nodeId, { direction: "in", types: ["MENTIONS"] });
  return mentions
    .map(({ node }) => node)
    .filter((node) => node.label === "Document" && (node.props.kind === "incident" || node.props.kind === "know-how"))
    .sort((a, b) => String(b.props.date).localeCompare(String(a.props.date)) || a.id.localeCompare(b.id));
}
