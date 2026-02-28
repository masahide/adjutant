import { dirname, isAbsolute, join, relative } from "node:path";
import type { CompactionEventTracker } from "./compaction-runtime.js";
import type { AgentSessionLike } from "./agent-session-factory.js";
import {
  getSessionEntry,
  parseIsoMs,
  upsertSessionEntry,
  type SessionEntryStore,
} from "./session-entry-store.js";

export type SessionLikeForStore = AgentSessionLike;

export type SessionStoreState = { path: string; store: SessionEntryStore };

type SessionStoreRepositoryRuntime = {
  openSessionManager: (params: {
    sessionKey: string;
    sessionId?: string;
    sessionEntriesPath: string;
    sessionEntryStore: SessionEntryStore;
    workspaceDir: string;
  }) => unknown;
  createSession: (params: {
    sessionManager: unknown;
    runId: string;
    sessionKey: string;
    model?: string;
    isHeartbeat?: boolean;
    memoryWriteEnabled?: boolean;
    memoryScope?: "main" | "spoke";
    workspaceDir: string;
  }) => Promise<{ session: SessionLikeForStore }>;
  loadSessionEntryStore: (
    customPath?: string
  ) => Promise<{ path: string; store: SessionEntryStore }>;
  saveSessionEntryStore: (store: SessionEntryStore, customPath?: string) => Promise<string>;
  repairSessionData: (sessionKey: string, sessionEntriesPath?: string) => Promise<boolean>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

export function resolveSessionFilePath(sessionEntriesPath: string, sessionFile: string): string {
  if (isAbsolute(sessionFile)) {
    return sessionFile;
  }
  return join(dirname(sessionEntriesPath), sessionFile);
}

export function toSessionStoreLockKey(sessionEntriesPath: string): string {
  return `session-entry-store:${sessionEntriesPath}`;
}

function relativizeSessionFilePath(sessionEntriesPath: string, sessionFile: string): string {
  if (!sessionFile || !isAbsolute(sessionFile)) {
    return sessionFile;
  }
  const relPath = relative(dirname(sessionEntriesPath), sessionFile);
  if (!relPath || relPath.startsWith("..")) {
    return sessionFile;
  }
  return relPath;
}

function getEntryUpdatedAt(store: SessionEntryStore, sessionKey: string): string | null {
  const entry = getSessionEntry(store, sessionKey);
  if (!entry) {
    return null;
  }
  return typeof entry.updatedAt === "string" ? entry.updatedAt : null;
}

function parseNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int >= 0 ? int : null;
}

function resolveUpdatedAt(params: {
  nowIso: string;
  isHeartbeat?: boolean;
  previousUpdatedAt: string | null;
}): string {
  if (!params.isHeartbeat) {
    return params.nowIso;
  }
  const previousMs = parseIsoMs(params.previousUpdatedAt);
  if (previousMs === null) {
    return params.nowIso;
  }
  const currentMs = parseIsoMs(params.nowIso);
  if (currentMs === null) {
    return new Date(previousMs).toISOString();
  }
  return new Date(Math.max(previousMs, currentMs)).toISOString();
}

function isSessionCorruptionError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    (message.includes("session") && message.includes("parse")) ||
    (message.includes("json") && message.includes("parse")) ||
    message.includes("corrupt") ||
    message.includes("malformed")
  );
}

export function resolveSessionMetadata(session: SessionLikeForStore): {
  sessionId?: string;
  sessionFile?: string;
  modelId?: string;
} {
  const modelRecord = asRecord(session.model);
  const modelId =
    typeof modelRecord?.id === "string" && modelRecord.id.trim()
      ? modelRecord.id.trim()
      : undefined;
  const sessionId =
    typeof session.sessionId === "string" && session.sessionId.trim()
      ? session.sessionId.trim()
      : undefined;
  const sessionFile =
    typeof session.sessionFile === "string" && session.sessionFile.trim()
      ? session.sessionFile.trim()
      : undefined;
  return {
    sessionId,
    sessionFile,
    modelId,
  };
}

export async function createSessionWithRecovery(params: {
  runtime: SessionStoreRepositoryRuntime;
  runId: string;
  sessionKey: string;
  sessionId?: string;
  sessionEntriesPath: string;
  sessionStoreState: SessionStoreState;
  workspaceDir: string;
  model?: string;
  isHeartbeat?: boolean;
  memoryWriteEnabled: boolean;
  memoryScope: "main" | "spoke";
}): Promise<{
  created: { session: SessionLikeForStore };
  sessionStoreState: SessionStoreState;
  previousUpdatedAt: string | null;
}> {
  const createWithStore = async (storeState: SessionStoreState) => {
    const sessionManager = params.runtime.openSessionManager({
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      sessionEntriesPath: params.sessionEntriesPath,
      sessionEntryStore: storeState.store,
      workspaceDir: params.workspaceDir,
    });
    return await params.runtime.createSession({
      sessionManager,
      runId: params.runId,
      sessionKey: params.sessionKey,
      model: params.model,
      isHeartbeat: params.isHeartbeat,
      memoryWriteEnabled: params.memoryWriteEnabled,
      memoryScope: params.memoryScope,
      workspaceDir: params.workspaceDir,
    });
  };

  let currentStoreState = params.sessionStoreState;
  let previousUpdatedAt = getEntryUpdatedAt(currentStoreState.store, params.sessionKey);

  try {
    const created = await createWithStore(currentStoreState);
    return { created, sessionStoreState: currentStoreState, previousUpdatedAt };
  } catch (error) {
    if (!isSessionCorruptionError(error)) {
      throw error;
    }
    const repaired = await params.runtime.repairSessionData(
      params.sessionKey,
      params.sessionEntriesPath
    );
    if (!repaired) {
      throw error;
    }
    currentStoreState = await params.runtime.loadSessionEntryStore(params.sessionEntriesPath);
    previousUpdatedAt = getEntryUpdatedAt(currentStoreState.store, params.sessionKey);
    const created = await createWithStore(currentStoreState);
    return { created, sessionStoreState: currentStoreState, previousUpdatedAt };
  }
}

export async function persistSessionStore(params: {
  runtime: Pick<SessionStoreRepositoryRuntime, "saveSessionEntryStore">;
  sessionStoreState: SessionStoreState;
  sessionKey: string;
  sessionMetadata: { sessionId?: string; sessionFile?: string };
  explicitSessionId?: string;
  nowIso: string;
  isHeartbeat?: boolean;
  previousUpdatedAt: string | null;
  compactionTracker: CompactionEventTracker;
  memoryFlushMetadata?: {
    executedAtIso: string;
    compactionCountAtFlush: number;
  };
}): Promise<void> {
  const entry = upsertSessionEntry(params.sessionStoreState.store, params.sessionKey);
  const sessionId = params.explicitSessionId || params.sessionMetadata.sessionId;
  if (sessionId) {
    entry.sessionId = sessionId;
  }
  if (params.sessionMetadata.sessionFile) {
    entry.sessionFile = relativizeSessionFilePath(
      params.sessionStoreState.path,
      params.sessionMetadata.sessionFile
    );
  }
  entry.updatedAt = resolveUpdatedAt({
    nowIso: params.nowIso,
    isHeartbeat: params.isHeartbeat,
    previousUpdatedAt: params.previousUpdatedAt,
  });

  const storedCompactionCount = parseNonNegativeInt(entry.compactionCount) ?? 0;
  const trackedCompactionCount = params.compactionTracker.getCompactionCount();
  entry.compactionCount = Math.max(storedCompactionCount, trackedCompactionCount);

  const context = params.compactionTracker.getContextSnapshot();
  entry.contextTokens = context.contextTokens;
  entry.contextWindowTokens = context.contextWindowTokens;

  if (params.memoryFlushMetadata) {
    entry.memoryFlushAt = params.memoryFlushMetadata.executedAtIso;
    entry.memoryFlushCompactionCount = params.memoryFlushMetadata.compactionCountAtFlush;
  }

  await params.runtime.saveSessionEntryStore(
    params.sessionStoreState.store,
    params.sessionStoreState.path
  );
}
