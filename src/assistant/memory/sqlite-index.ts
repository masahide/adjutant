import { mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MemoryPathGuard } from "./path-guard.js";
import type { MemorySearchResult, MemorySearchRuntimeConfig } from "./types.js";

interface MemoryDocRow {
  path: string;
  content: string;
  updated_at: number;
}

interface FileEntry {
  relPath: string;
  absPath: string;
  content: string;
}

function toLines(content: string): string[] {
  return content.split("\n");
}

function findBestLine(lines: string[], query: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return 1;
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line?.toLowerCase().includes(normalizedQuery)) {
      return index + 1;
    }
  }
  return 1;
}

function computeScore(content: string, query: string): number {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
  if (terms.length === 0) {
    return 0;
  }

  const normalized = content.toLowerCase();
  let hits = 0;
  for (const term of terms) {
    if (normalized.includes(term)) {
      hits += 1;
    }
  }
  return hits / terms.length;
}

function trimSnippet(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...`;
}

function asWorkspaceRelPath(workspaceDir: string, absPath: string): string {
  const normalizedWorkspace = workspaceDir.replaceAll("\\", "/").replace(/\/$/, "");
  const normalizedPath = absPath.replaceAll("\\", "/");
  if (!normalizedPath.startsWith(`${normalizedWorkspace}/`)) {
    return normalizedPath;
  }
  return normalizedPath.slice(normalizedWorkspace.length + 1);
}

export class MemorySqliteIndex {
  private readonly workspaceDir: string;
  private readonly config: MemorySearchRuntimeConfig;
  private readonly db: DatabaseSync;
  private readonly pathGuard: MemoryPathGuard;

  constructor(params: { workspaceDir: string; config: MemorySearchRuntimeConfig }) {
    this.workspaceDir = resolve(params.workspaceDir);
    this.config = params.config;
    this.pathGuard = new MemoryPathGuard(this.workspaceDir);
    mkdirSync(dirname(resolve(params.config.dbPath)), { recursive: true });
    this.db = new DatabaseSync(resolve(params.config.dbPath));
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_documents (
        path TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  async sync(): Promise<void> {
    await mkdir(dirname(resolve(this.config.dbPath)), { recursive: true });
    const files = await this.collectFiles();
    const byPath = new Map(files.map((entry) => [entry.relPath, entry]));

    const currentRows = this.db.prepare("SELECT path FROM memory_documents").all() as Array<{
      path: string;
    }>;
    for (const row of currentRows) {
      if (!byPath.has(row.path)) {
        this.db.prepare("DELETE FROM memory_documents WHERE path = ?").run(row.path);
      }
    }

    for (const file of files) {
      this.db
        .prepare(
          `INSERT INTO memory_documents(path, content, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
        )
        .run(file.relPath, file.content, Date.now());
    }
  }

  async search(
    query: string,
    options?: { maxResults?: number; minScore?: number }
  ): Promise<{
    results: MemorySearchResult[];
    provider: string;
    model: string;
  }> {
    await this.sync();
    const maxResults = Math.max(1, Math.floor(options?.maxResults ?? this.config.maxResults));
    const minScore = Math.max(0, options?.minScore ?? this.config.minScore);
    const rows = this.db
      .prepare("SELECT path, content, updated_at FROM memory_documents ORDER BY updated_at DESC")
      .all() as unknown as MemoryDocRow[];

    const ranked: MemorySearchResult[] = [];
    for (const row of rows) {
      const score = computeScore(row.content, query);
      if (score < minScore || score <= 0) {
        continue;
      }
      const lines = toLines(row.content);
      const startLine = findBestLine(lines, query);
      const endLine = Math.min(lines.length, startLine + 4);
      ranked.push({
        path: row.path,
        startLine,
        endLine,
        score,
        snippet: trimSnippet(lines.slice(startLine - 1, endLine).join("\n"), 700),
        source: "memory",
      });
    }

    return {
      results: ranked.sort((a, b) => b.score - a.score).slice(0, maxResults),
      provider: "local",
      model: "sqlite-basic",
    };
  }

  async readFile(params: { relPath: string; from?: number; lines?: number }): Promise<{
    path: string;
    text: string;
  }> {
    const resolvedPath = await this.pathGuard.resolveReadablePath(params.relPath);
    const content = await readFile(resolvedPath.absPath, "utf8");
    if (params.from === undefined && params.lines === undefined) {
      return { path: resolvedPath.relPath, text: content };
    }

    const allLines = content.split("\n");
    const start = Math.max(1, Math.floor(params.from ?? 1));
    const count = Math.max(1, Math.floor(params.lines ?? allLines.length));
    return {
      path: resolvedPath.relPath,
      text: allLines.slice(start - 1, start - 1 + count).join("\n"),
    };
  }

  close(): void {
    this.db.close();
  }

  private async collectFiles(): Promise<FileEntry[]> {
    const files: string[] = [];
    const longTermCandidates = ["MEMORY.md", "memory.md"];
    for (const filename of longTermCandidates) {
      const absPath = join(this.workspaceDir, filename);
      try {
        const info = await stat(absPath);
        if (info.isFile()) {
          files.push(absPath);
        }
      } catch {
        // ignore missing
      }
    }

    const memoryDir = join(this.workspaceDir, "memory");
    await this.walkMarkdown(memoryDir, files);

    const unique = Array.from(new Set(files));
    const entries: FileEntry[] = [];
    for (const filePath of unique) {
      const absRealPath = await realpath(filePath).catch(() => filePath);
      const relPath = asWorkspaceRelPath(this.workspaceDir, absRealPath);
      const content = await readFile(absRealPath, "utf8");
      entries.push({
        relPath,
        absPath: absRealPath,
        content,
      });
    }
    return entries;
  }

  private async walkMarkdown(dirPath: string, out: string[]): Promise<void> {
    let entries: Array<{
      name: string;
      isFile: () => boolean;
      isDirectory: () => boolean;
      isSymbolicLink: () => boolean;
    }>;
    try {
      entries = (await readdir(dirPath, {
        withFileTypes: true,
        encoding: "utf8",
      })) as Array<{
        name: string;
        isFile: () => boolean;
        isDirectory: () => boolean;
        isSymbolicLink: () => boolean;
      }>;
    } catch {
      return;
    }

    for (const entry of entries) {
      const absPath = join(dirPath, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await this.walkMarkdown(absPath, out);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        out.push(absPath);
      }
    }
  }
}

const managerCache = new Map<string, MemorySqliteIndex>();

export function getOrCreateMemorySqliteIndex(params: {
  workspaceDir: string;
  config: MemorySearchRuntimeConfig;
}): MemorySqliteIndex {
  const key = `${resolve(params.workspaceDir)}::${resolve(params.config.dbPath)}`;
  const existing = managerCache.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created = new MemorySqliteIndex(params);
  managerCache.set(key, created);
  return created;
}

export function clearMemorySqliteIndexCacheForTest(): void {
  for (const value of managerCache.values()) {
    value.close();
  }
  managerCache.clear();
}
