export const FILES_TABLE = "files";
export const CHUNKS_TABLE = "chunks";
export const FTS_TABLE = "chunks_fts";
export const VECTOR_TABLE = "chunks_vec";

export const SQL = {
  createFilesTable: `
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    );
  `,
  createChunksTable: `
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `,
  createChunksPathIndex: `
    CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
  `,
  createFtsTable: `
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text,
      id UNINDEXED,
      path UNINDEXED,
      source UNINDEXED,
      model UNINDEXED,
      start_line UNINDEXED,
      end_line UNINDEXED
    );
  `,
  selectFileHashes: `SELECT path, hash FROM files`,
  selectChunkIdsByPath: `SELECT id FROM chunks WHERE path = ?`,
  deleteVectorById: `DELETE FROM chunks_vec WHERE id = ?`,
  deleteFtsById: `DELETE FROM chunks_fts WHERE id = ?`,
  deleteChunksByPath: `DELETE FROM chunks WHERE path = ?`,
  deleteFileByPath: `DELETE FROM files WHERE path = ?`,
  upsertFile: `
    INSERT INTO files(path, source, hash, mtime, size)
    VALUES (?, 'memory', ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      hash=excluded.hash,
      mtime=excluded.mtime,
      size=excluded.size
  `,
  insertChunk: `
    INSERT INTO chunks(
      id, path, source, start_line, end_line, hash, model, text, embedding, updated_at
    ) VALUES (?, ?, 'memory', ?, ?, ?, ?, ?, ?, ?)
  `,
  insertFtsChunk: `
    INSERT INTO chunks_fts(text, id, path, source, model, start_line, end_line)
    VALUES (?, ?, ?, 'memory', ?, ?, ?)
  `,
  insertVectorChunk: `INSERT INTO chunks_vec(id, embedding) VALUES (?, ?)`,
  dropVectorTable: `DROP TABLE IF EXISTS chunks_vec`,
  selectVectorCandidates: `
    SELECT c.id, c.path, c.start_line, c.end_line, c.text, c.source,
           vec_distance_cosine(v.embedding, ?) AS dist
      FROM chunks_vec v
      JOIN chunks c ON c.id = v.id
     WHERE c.model = ?
     ORDER BY dist ASC
     LIMIT ?
  `,
  selectKeywordCandidates: `
    SELECT id, path, source, start_line, end_line, text,
           bm25(chunks_fts) AS rank
      FROM chunks_fts
     WHERE chunks_fts MATCH ? AND model = ?
     ORDER BY rank ASC
     LIMIT ?
  `,
} as const;

export function createVectorTableSql(dimensions: number): string {
  return (
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(\n` +
    `  id TEXT PRIMARY KEY,\n` +
    `  embedding FLOAT[${dimensions}]\n` +
    `)`
  );
}
