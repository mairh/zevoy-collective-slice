import { guardedFetch } from "../router/egress";
/** Turns text into vectors. Two implementations: Ollama (the real one) and a labelled offline fallback. */
export interface Embedder {
  readonly name: string;
  readonly dimensions: number;
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

export const OLLAMA_URL = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";

/** True when an Ollama server answers on localhost and has the model pulled. */
export async function ollamaHasModel(model: string): Promise<boolean> {
  try {
    const response = await guardedFetch(
      `${OLLAMA_URL}/api/tags`,
      { signal: AbortSignal.timeout(800) },
      { purpose: "embedding model availability check", dataClass: "public" },
    );
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { models?: { name: string }[] };
    return (body.models ?? []).some((entry) => entry.name === model || entry.name.startsWith(`${model}:`));
  } catch {
    return false;
  }
}

/** nomic-embed-text through a local Ollama. Uses the model's task prefixes. */
export class OllamaEmbedder implements Embedder {
  readonly name: string;
  dimensions = 768;

  constructor(private readonly model = "nomic-embed-text") {
    this.name = `ollama/${model}`;
  }

  private async embed(inputs: string[]): Promise<Float32Array[]> {
    const response = await guardedFetch(
      `${OLLAMA_URL}/api/embed`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input: inputs }),
      },
      // Embedding input is raw repository source: proprietary, so it only ever goes to the local model.
      { purpose: "embedding", dataClass: "proprietary-source" },
    );
    if (!response.ok) {
      throw new Error(`Ollama embed failed with ${response.status}`);
    }
    const body = (await response.json()) as { embeddings: number[][] };
    const vectors = body.embeddings.map((vector) => Float32Array.from(vector));
    this.dimensions = vectors[0]?.length ?? this.dimensions;
    return vectors;
  }

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let index = 0; index < texts.length; index += 32) {
      out.push(...(await this.embed(texts.slice(index, index + 32).map((text) => `search_document: ${text}`))));
    }
    return out;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [vector] = await this.embed([`search_query: ${text}`]);
    if (!vector) {
      throw new Error("Ollama returned no embedding");
    }
    return vector;
  }
}

const STOPWORDS = new Set(
  "the a an and or of to in on for with from by is are be as at it this that into its their user users add show".split(
    " ",
  ),
);

/** Splits camelCase, PascalCase and snake_case identifiers into lower-case words. */
export function tokenise(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
    .map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word));
}

function fnv1a(word: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < word.length; index += 1) {
    hash ^= word.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Offline fallback: signed feature hashing over identifier tokens, log-scaled and L2-normalised. Deterministic and
 * dependency-free. It is lexical, not semantic, and the CLI says so whenever it is in use.
 */
export class HashEmbedder implements Embedder {
  readonly name = "hash-fallback (lexical, Ollama unavailable)";

  constructor(readonly dimensions = 512) {}

  private vector(text: string): Float32Array {
    const counts = new Map<string, number>();
    for (const word of tokenise(text)) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    const out = new Float32Array(this.dimensions);
    for (const [word, count] of counts) {
      const hash = fnv1a(word);
      const sign = hash & 1 ? 1 : -1;
      const slot = (hash >>> 1) % this.dimensions;
      out[slot] = (out[slot] ?? 0) + sign * (1 + Math.log(count));
    }
    const norm = Math.hypot(...out) || 1;
    return out.map((value) => value / norm);
  }

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.vector(text));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.vector(text);
  }
}

/** Picks Ollama when it is running locally with the model pulled, otherwise the labelled fallback. */
export async function selectEmbedder(preference: "auto" | "ollama" | "hash" = "auto"): Promise<Embedder> {
  if (preference === "hash") {
    return new HashEmbedder();
  }
  if (await ollamaHasModel("nomic-embed-text")) {
    return new OllamaEmbedder();
  }
  if (preference === "ollama") {
    throw new Error(
      `Ollama with nomic-embed-text is not reachable at ${OLLAMA_URL}. Run: ollama pull nomic-embed-text`,
    );
  }
  return new HashEmbedder();
}
