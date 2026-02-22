import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chunkMarkdownByChars } from "./chunker.js";
import { OpenAiEmbeddingProvider } from "./embedding-provider.js";
import { MemorySearchError } from "./errors.js";
import { MemoryPathGuard } from "./path-guard.js";
import { SQL, createVectorTableSql } from "./sql.js";
import type {
  EmbeddingProvider,
  MemoryFileRecord,
  MemorySearchResult,
  MemorySearchRuntimeConfig,
} from "./types.js";

const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);

function hashText(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars))}...`;
}

function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[A-Za-z0-9_]+/g)
      ?.map((token) => token.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((token) => `"${token.replaceAll('"', "")}"`).join(" AND ");
}

function bm25RankToScore(rank: number): number {
  const normalized = Number.isFinite(rank) ? Math.max(0, rank) : 999;
  return 1 / (1 + normalized);
}

type ChunkRow = {
  id: string;
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  source: "memory";
};

export class MemorySearchManager {
  private readonly workspaceDir: string;
  private readonly cfg: MemorySearchRuntimeConfig;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly db: DatabaseSync;
  private readonly pathGuard: MemoryPathGuard;
  private vectorDims: number | null = null;
  private hasVectorTable = false;
  private syncPromise: Promise<void> | null = null;

  static async create(params: {
    workspaceDir: string;
    config: MemorySearchRuntimeConfig;
    embeddingProvider?: EmbeddingProvider;
  }): Promise<MemorySearchManager> {
    const resolvedDbPath = resolve(params.config.dbPath);
    await mkdir(dirname(resolvedDbPath), { recursive: true });
    const embeddingProvider =
      params.embeddingProvider ??
      new OpenAiEmbeddingProvider({
        model: params.config.model,
        apiKey: process.env.OPENAI_API_KEY,
      });
    const config = {
      ...params.config,
      dbPath: resolvedDbPath,
    };
    const manager = new MemorySearchManager({
      workspaceDir: params.workspaceDir,
      config,
      embeddingProvider,
    });
    await manager.initialize();
    return manager;
  }

  private constructor(params: {
    workspaceDir: string;
    config: MemorySearchRuntimeConfig;
    embeddingProvider: EmbeddingProvider;
  }) {
    this.workspaceDir = resolve(params.workspaceDir);
    this.cfg = params.config;
    this.embeddingProvider = params.embeddingProvider;
    this.pathGuard = new MemoryPathGuard(this.workspaceDir);
    const dbPath = resolve(params.config.dbPath);
    this.db = new DatabaseSync(dbPath, {
      allowExtension: true,
      readOnly: false,
      open: true,
    });
  }

  private async initialize(): Promise<void> {
    if (!this.cfg.vectorEnabled) {
      throw new MemorySearchError("index_unavailable", "memory_search requires vector search");
    }
    this.ensureSchema();
    await this.loadSqliteVecOrThrow();
  }

  private ensureSchema(): void {
    this.db.exec(SQL.createFilesTable);
    this.db.exec(SQL.createChunksTable);
    this.db.exec(SQL.createChunksPathIndex);
    this.db.exec(SQL.createFtsTable);
  }

  private async loadSqliteVecOrThrow(): Promise<void> {
    try {
      const sqliteVec = await import("sqlite-vec");
      const extensionPath = this.cfg.sqliteVecPath.trim();
      this.db.enableLoadExtension(true);
      if (extensionPath) {
        this.db.loadExtension(extensionPath);
      } else {
        sqliteVec.load(this.db);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new MemorySearchError("index_unavailable", `sqlite-vec unavailable: ${reason}`, error);
    }
  }

  async search(
    query: string,
    options?: { maxResults?: number; minScore?: number }
  ): Promise<{
    results: MemorySearchResult[];
    provider: string;
    model: string;
    fallback?: { from: string; reason?: string };
  }> {
    await this.syncIndex();
    const cleaned = query.trim();
    if (!cleaned) {
      return {
        results: [],
        provider: this.embeddingProvider.provider,
        model: this.embeddingProvider.model,
      };
    }

    const maxResults = Math.max(1, Math.floor(options?.maxResults ?? this.cfg.maxResults));
    const minScore = Math.max(0, options?.minScore ?? this.cfg.minScore);
    const limit = Math.max(1, Math.floor(maxResults * this.cfg.candidateMultiplier));

    const keywordResults = this.searchKeyword(cleaned, limit);
    let vectorResults: Array<MemorySearchResult & { id: string }> = [];
    let fallbackReason: string | undefined;

    try {
      const queryEmbedding = await this.embeddingProvider.embedQuery(cleaned);
      vectorResults = this.searchVector(queryEmbedding, limit);
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message : String(error);
    }

    const merged = this.mergeHybrid({
      vectorResults,
      keywordResults,
    })
      .filter((entry) => entry.score >= minScore)
      .slice(0, maxResults);

    return {
      results: merged,
      provider: this.embeddingProvider.provider,
      model: this.embeddingProvider.model,
      ...(fallbackReason
        ? {
            fallback: {
              from: this.embeddingProvider.provider,
              reason: fallbackReason,
            },
          }
        : {}),
    };
  }

  private searchVector(
    queryEmbedding: number[],
    limit: number
  ): Array<MemorySearchResult & { id: string }> {
    if (
      !this.hasVectorTable ||
      this.vectorDims === null ||
      queryEmbedding.length !== this.vectorDims
    ) {
      return [];
    }
    const rows = this.db
      .prepare(SQL.selectVectorCandidates)
      .all(vectorToBlob(queryEmbedding), this.embeddingProvider.model, limit) as Array<
      ChunkRow & { dist: number }
    >;
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      score: 1 - row.dist,
      snippet: truncateText(row.text, this.cfg.snippetMaxChars),
      source: "memory",
    }));
  }

  private searchKeyword(
    query: string,
    limit: number
  ): Array<MemorySearchResult & { id: string; textScore: number }> {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) {
      return [];
    }
    const rows = this.db
      .prepare(SQL.selectKeywordCandidates)
      .all(ftsQuery, this.embeddingProvider.model, limit) as Array<ChunkRow & { rank: number }>;
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      textScore: bm25RankToScore(row.rank),
      score: bm25RankToScore(row.rank),
      snippet: truncateText(row.text, this.cfg.snippetMaxChars),
      source: "memory",
    }));
  }

  private mergeHybrid(params: {
    vectorResults: Array<MemorySearchResult & { id: string }>;
    keywordResults: Array<MemorySearchResult & { id: string; textScore: number }>;
  }): MemorySearchResult[] {
    const byId = new Map<
      string,
      {
        path: string;
        startLine: number;
        endLine: number;
        snippet: string;
        vectorScore: number;
        textScore: number;
      }
    >();

    for (const row of params.vectorResults) {
      byId.set(row.id, {
        path: row.path,
        startLine: row.startLine,
        endLine: row.endLine,
        snippet: row.snippet,
        vectorScore: row.score,
        textScore: 0,
      });
    }

    for (const row of params.keywordResults) {
      const existing = byId.get(row.id);
      if (existing) {
        existing.textScore = row.textScore;
        if (row.snippet.length > 0) {
          existing.snippet = row.snippet;
        }
        continue;
      }
      byId.set(row.id, {
        path: row.path,
        startLine: row.startLine,
        endLine: row.endLine,
        snippet: row.snippet,
        vectorScore: 0,
        textScore: row.textScore,
      });
    }

    return [...byId.values()]
      .map((row) => ({
        path: row.path,
        startLine: row.startLine,
        endLine: row.endLine,
        snippet: row.snippet,
        source: "memory" as const,
        score: this.cfg.vectorWeight * row.vectorScore + this.cfg.textWeight * row.textScore,
      }))
      .sort((a, b) => b.score - a.score);
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ path: string; text: string }> {
    let resolvedPath: { relPath: string; absPath: string };
    try {
      resolvedPath = await this.pathGuard.resolveReadablePath(params.relPath);
    } catch (error) {
      throw new MemorySearchError("permission_denied", "path required", error);
    }

    const content = await readFile(resolvedPath.absPath, "utf8");

    if (params.from === undefined && params.lines === undefined) {
      return { path: resolvedPath.relPath, text: content };
    }

    const allLines = content.split("\n");
    const startLine = Math.max(1, Math.floor(params.from ?? 1));
    const lineCount = Math.max(1, Math.floor(params.lines ?? allLines.length));
    const sliced = allLines.slice(startLine - 1, startLine - 1 + lineCount).join("\n");
    return { path: resolvedPath.relPath, text: sliced };
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private async syncIndex(): Promise<void> {
    if (this.syncPromise) {
      return this.syncPromise;
    }
    this.syncPromise = this.runSyncIndex().finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  private async runSyncIndex(): Promise<void> {
    const files = await this.listMemoryFiles();
    const fileMap = new Map(files.map((file) => [file.path, file]));
    const currentRows = this.db.prepare(SQL.selectFileHashes).all() as Array<{
      path: string;
      hash: string;
    }>;

    const removedPaths = currentRows.map((row) => row.path).filter((path) => !fileMap.has(path));
    for (const removed of removedPaths) {
      this.deletePath(removed);
    }

    for (const file of files) {
      const existing = currentRows.find((row) => row.path === file.path);
      if (existing && existing.hash === file.hash) {
        continue;
      }
      await this.upsertFile(file);
    }
  }

  private async listMemoryFiles(): Promise<MemoryFileRecord[]> {
    const files: string[] = [];
    const memoryLongTerm = join(this.workspaceDir, "MEMORY.md");
    const memoryDir = join(this.workspaceDir, "memory");

    const addIfMarkdown = async (absPath: string) => {
      try {
        const info = await stat(absPath);
        if (!info.isFile()) {
          return;
        }
        if (!absPath.toLowerCase().endsWith(".md")) {
          return;
        }
        files.push(absPath);
      } catch {
        // ignore
      }
    };

    const walkMarkdown = async (dirPath: string): Promise<void> => {
      try {
        const entries = await readdir(dirPath, { withFileTypes: true, encoding: "utf8" });
        for (const entry of entries) {
          const absPath = join(dirPath, entry.name);
          if (entry.isSymbolicLink()) {
            continue;
          }
          if (entry.isDirectory()) {
            await walkMarkdown(absPath);
            continue;
          }
          if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
            files.push(absPath);
          }
        }
      } catch {
        return;
      }
    };

    await addIfMarkdown(memoryLongTerm);
    await walkMarkdown(memoryDir);

    const deduped = Array.from(new Set(files));
    const result: MemoryFileRecord[] = [];
    for (const absPath of deduped) {
      const absRealPath = await realpath(absPath).catch(() => absPath);
      const content = await readFile(absRealPath, "utf8");
      const info = await stat(absRealPath);
      const relPath = relative(this.workspaceDir, absRealPath).replaceAll("\\", "/");
      result.push({
        path: relPath,
        absPath: absRealPath,
        content,
        hash: hashText(content),
        mtimeMs: info.mtimeMs,
        size: info.size,
      });
    }
    return result;
  }

  private deletePath(relPath: string): void {
    const ids = this.db.prepare(SQL.selectChunkIdsByPath).all(relPath) as Array<{ id: string }>;
    for (const row of ids) {
      if (this.hasVectorTable) {
        this.db.prepare(SQL.deleteVectorById).run(row.id);
      }
      this.db.prepare(SQL.deleteFtsById).run(row.id);
    }
    this.db.prepare(SQL.deleteChunksByPath).run(relPath);
    this.db.prepare(SQL.deleteFileByPath).run(relPath);
  }

  private async upsertFile(file: MemoryFileRecord): Promise<void> {
    this.deletePath(file.path);
    this.db.prepare(SQL.upsertFile).run(file.path, file.hash, Math.floor(file.mtimeMs), file.size);

    const chunks = chunkMarkdownByChars({
      content: file.content,
      chunkChars: this.cfg.chunkChars,
      chunkOverlapChars: this.cfg.chunkOverlapChars,
    });
    if (chunks.length === 0) {
      return;
    }

    let embeddings: number[][] = [];
    try {
      embeddings = await this.embeddingProvider.embedTexts(chunks.map((chunk) => chunk.text));
    } catch {
      embeddings = [];
    }

    if (embeddings.length > 0) {
      const dims = embeddings[0]?.length ?? 0;
      if (dims > 0) {
        this.ensureVectorTable(dims);
      }
    }

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (!chunk) {
        continue;
      }
      const chunkId = hashText(
        `${file.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${this.embeddingProvider.model}`
      );
      const embedding = embeddings[index] ?? [];
      const serializedEmbedding = JSON.stringify(embedding);

      this.db
        .prepare(SQL.insertChunk)
        .run(
          chunkId,
          file.path,
          chunk.startLine,
          chunk.endLine,
          chunk.hash,
          this.embeddingProvider.model,
          chunk.text,
          serializedEmbedding,
          Date.now()
        );

      this.db
        .prepare(SQL.insertFtsChunk)
        .run(
          chunk.text,
          chunkId,
          file.path,
          this.embeddingProvider.model,
          chunk.startLine,
          chunk.endLine
        );

      if (
        this.hasVectorTable &&
        this.vectorDims !== null &&
        embedding.length === this.vectorDims &&
        this.vectorDims > 0
      ) {
        this.db.prepare(SQL.insertVectorChunk).run(chunkId, vectorToBlob(embedding));
      }
    }
  }

  private ensureVectorTable(dimensions: number): void {
    if (dimensions <= 0) {
      return;
    }
    if (this.vectorDims === dimensions && this.hasVectorTable) {
      return;
    }
    if (this.hasVectorTable && this.vectorDims !== dimensions) {
      this.db.exec(SQL.dropVectorTable);
      this.hasVectorTable = false;
    }
    this.db.exec(createVectorTableSql(dimensions));
    this.vectorDims = dimensions;
    this.hasVectorTable = true;
  }
}

const managerCache = new Map<string, Promise<MemorySearchManager>>();

export async function getOrCreateMemorySearchManager(params: {
  workspaceDir: string;
  config: MemorySearchRuntimeConfig;
  embeddingProvider?: EmbeddingProvider;
}): Promise<MemorySearchManager> {
  const key = JSON.stringify({
    workspaceDir: resolve(params.workspaceDir),
    dbPath: resolve(params.config.dbPath),
    model: params.config.model,
    vectorEnabled: params.config.vectorEnabled,
  });
  const existing = managerCache.get(key);
  if (existing) {
    return existing;
  }
  const created = MemorySearchManager.create(params);
  managerCache.set(key, created);
  return created;
}

export async function clearMemorySearchManagerCacheForTest(): Promise<void> {
  const entries = Array.from(managerCache.values());
  managerCache.clear();
  const resolved = await Promise.allSettled(entries);
  for (const item of resolved) {
    if (item.status === "fulfilled") {
      await item.value.close();
    }
  }
}
