import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SESSION_COMPACTION_SCHEMA_V1 = "adjutant.sessions.compaction.v1";

export interface SessionCompactionEntry {
  compactionCount: number;
  memoryFlushCompactionCount: number | null;
  memoryFlushAt?: string;
  contextTokens?: number | null;
  contextWindowTokens?: number | null;
  updatedAt: string;
}

type SessionCompactionFile = {
  schema: typeof SESSION_COMPACTION_SCHEMA_V1;
  updatedAt: string;
  sessions: Record<string, SessionCompactionEntry>;
};

function createEmptyFile(nowIso: string): SessionCompactionFile {
  return {
    schema: SESSION_COMPACTION_SCHEMA_V1,
    updatedAt: nowIso,
    sessions: {},
  };
}

function parseCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function parseOptionalCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.floor(value));
}

function parseOptionalIso(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return new Date(parsed).toISOString();
}

function normalizeFile(input: unknown): SessionCompactionFile {
  const nowIso = new Date().toISOString();
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return createEmptyFile(nowIso);
  }
  const root = input as Record<string, unknown>;
  if (root.schema !== SESSION_COMPACTION_SCHEMA_V1) {
    return createEmptyFile(nowIso);
  }
  const sessionsInput =
    typeof root.sessions === "object" && root.sessions !== null && !Array.isArray(root.sessions)
      ? (root.sessions as Record<string, unknown>)
      : {};

  const sessions: Record<string, SessionCompactionEntry> = {};
  for (const [sessionKey, value] of Object.entries(sessionsInput)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const entry = value as Record<string, unknown>;
    const updatedAt = parseOptionalIso(entry.updatedAt) ?? nowIso;
    sessions[sessionKey] = {
      compactionCount: parseCount(entry.compactionCount),
      memoryFlushCompactionCount: parseOptionalCount(entry.memoryFlushCompactionCount),
      memoryFlushAt: parseOptionalIso(entry.memoryFlushAt),
      contextTokens:
        typeof entry.contextTokens === "number" && Number.isFinite(entry.contextTokens)
          ? Math.max(0, Math.floor(entry.contextTokens))
          : null,
      contextWindowTokens:
        typeof entry.contextWindowTokens === "number" && Number.isFinite(entry.contextWindowTokens)
          ? Math.max(0, Math.floor(entry.contextWindowTokens))
          : null,
      updatedAt,
    };
  }

  return {
    schema: SESSION_COMPACTION_SCHEMA_V1,
    updatedAt: parseOptionalIso(root.updatedAt) ?? nowIso,
    sessions,
  };
}

async function writeJsonAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, filePath);
}

export class SessionCompactionStore {
  private readonly filePath: string;
  private readonly bySessionKey = new Map<string, SessionCompactionEntry>();

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  static fromStateDir(stateDir: string): SessionCompactionStore {
    return new SessionCompactionStore(resolve(stateDir, "worker", "sessions.json"));
  }

  async initialize(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = normalizeFile(JSON.parse(raw));
      this.bySessionKey.clear();
      for (const [sessionKey, entry] of Object.entries(parsed.sessions)) {
        this.bySessionKey.set(sessionKey, entry);
      }
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") {
        return;
      }
      // recover as empty map on malformed file
      this.bySessionKey.clear();
    }
  }

  get(sessionKey: string): SessionCompactionEntry | undefined {
    return this.bySessionKey.get(sessionKey);
  }

  async upsert(
    sessionKey: string,
    next: Partial<SessionCompactionEntry>
  ): Promise<SessionCompactionEntry> {
    const nowIso = new Date().toISOString();
    const current = this.bySessionKey.get(sessionKey);
    const merged: SessionCompactionEntry = {
      compactionCount: parseCount(next.compactionCount ?? current?.compactionCount ?? 0),
      memoryFlushCompactionCount: parseOptionalCount(
        next.memoryFlushCompactionCount ?? current?.memoryFlushCompactionCount ?? null
      ),
      memoryFlushAt: parseOptionalIso(next.memoryFlushAt ?? current?.memoryFlushAt),
      contextTokens:
        typeof next.contextTokens === "number"
          ? Math.max(0, Math.floor(next.contextTokens))
          : (current?.contextTokens ?? null),
      contextWindowTokens:
        typeof next.contextWindowTokens === "number"
          ? Math.max(0, Math.floor(next.contextWindowTokens))
          : (current?.contextWindowTokens ?? null),
      updatedAt: nowIso,
    };

    this.bySessionKey.set(sessionKey, merged);
    await this.persist(nowIso);
    return merged;
  }

  private async persist(updatedAt: string): Promise<void> {
    const sessions = Object.fromEntries(this.bySessionKey.entries());
    const payload: SessionCompactionFile = {
      schema: SESSION_COMPACTION_SCHEMA_V1,
      updatedAt,
      sessions,
    };
    await writeJsonAtomic(this.filePath, `${JSON.stringify(payload, null, 2)}\n`);
  }
}
