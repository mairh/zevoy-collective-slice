import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Sensitivity } from "../config";
import type { Chunk } from "../ingest/chunk";

export interface VectorHit {
  chunkId: string;
  nodeId: string;
  sourceFile: string;
  symbol: string;
  sensitivity: Sensitivity;
  score: number;
}

/**
 * Vector store contract. The Astra DB implementation would map upsert to `collection.insertMany` with `$vector`
 * and query to `find({}, { sort: { $vector }, limit })`. It is not built in this slice; see README.
 */
export interface VectorStore {
  readonly backend: string;
  reset(dimensions: number): Promise<void>;
  upsert(chunks: Chunk[], vectors: Float32Array[]): Promise<void>;
  query(vector: Float32Array, k: number): Promise<VectorHit[]>;
  count(): Promise<number>;
}

function toSensitivity(value: string): Sensitivity {
  return value === "financial" || value === "public" ? value : "internal";
}

/** SQLite + sqlite-vec through node:sqlite. Local file, no server, cosine distance. */
export class SqliteVecStore implements VectorStore {
  readonly backend = "sqlite-vec";

  private constructor(private readonly db: DatabaseSync) {}

  /** Opens (or creates) the database file and loads the sqlite-vec extension. */
  static async open(path: string): Promise<SqliteVecStore> {
    mkdirSync(dirname(path), { recursive: true });
    const { DatabaseSync: Database } = await import("node:sqlite");
    const sqliteVec = await import("sqlite-vec");
    const db = new Database(path, { allowExtension: true });
    db.loadExtension(sqliteVec.getLoadablePath());
    return new SqliteVecStore(db);
  }

  async reset(dimensions: number): Promise<void> {
    this.db.exec("DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS vec_chunks;");
    this.db.exec(
      "CREATE TABLE chunks (rowid INTEGER PRIMARY KEY, id TEXT UNIQUE, node_id TEXT, source_file TEXT, symbol TEXT, sensitivity TEXT, text TEXT);",
    );
    this.db.exec(`CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[${dimensions}] distance_metric=cosine);`);
  }

  async upsert(chunks: Chunk[], vectors: Float32Array[]): Promise<void> {
    const insertChunk = this.db.prepare(
      "INSERT INTO chunks (rowid, id, node_id, source_file, symbol, sensitivity, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insertVector = this.db.prepare("INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)");
    this.db.exec("BEGIN");
    chunks.forEach((chunk, index) => {
      const vector = vectors[index];
      if (!vector) {
        return;
      }
      const rowid = BigInt(index + 1);
      insertChunk.run(rowid, chunk.id, chunk.nodeId, chunk.sourceFile, chunk.symbol, chunk.sensitivity, chunk.text);
      insertVector.run(rowid, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
    });
    this.db.exec("COMMIT");
  }

  async query(vector: Float32Array, k: number): Promise<VectorHit[]> {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.node_id, c.source_file, c.symbol, c.sensitivity, v.distance
         FROM vec_chunks v JOIN chunks c ON c.rowid = v.rowid
         WHERE v.embedding MATCH ? AND k = ? ORDER BY v.distance`,
      )
      .all(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), k);
    return rows.map((row) => ({
      chunkId: String(row.id),
      nodeId: String(row.node_id),
      sourceFile: String(row.source_file),
      symbol: String(row.symbol),
      sensitivity: toSensitivity(String(row.sensitivity)),
      score: 1 - Number(row.distance),
    }));
  }

  async count(): Promise<number> {
    const row = this.db.prepare("SELECT count(*) AS n FROM chunks").get();
    return row ? Number(row.n) : 0;
  }
}
