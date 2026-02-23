import { SessionManager } from "@mariozechner/pi-coding-agent";
import { constants as fsConstants } from "node:fs";
import { access, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { auditRunEnd, auditRunStart, type AgentAuditScope } from "./agent-audit.js";
import { appendDailyMemory, updateLongTermMemory } from "./memory-writer.js";
import { readMemoryFiles } from "./memory-reader.js";
import {
  createCompactionEventTracker,
  resolveCompactionRuntimeSettings,
  resolveSessionCompactionMetadata,
  shouldRunPreCompactionMemoryFlush,
  type CompactionEventTracker,
} from "./compaction-runtime.js";
import {
  readSessionEntryStore,
  writeSessionEntryStore,
  getSessionEntry,
  upsertSessionEntry,
  type SessionEntryStore,
} from "./session-entry-store.js";
import {
  ensureWorkspaceBootstrapFiles,
  loadWorkspaceBootstrapFiles,
} from "./workspace-bootstrap.js";
import {
  createAgentSessionFromSdk,
  isAgentModelAvailable,
  type AgentSessionLike,
} from "./agent-session-factory.js";
import { createAgentEventSubscriber } from "./agent-event-subscriber.js";
import {
  buildAgentPrompt,
  resolveAgentRunContext,
  shouldInjectBootstrapContext,
} from "./agent-prompt-builder.js";
import { AgentRunExecutor } from "./agent-run-executor.js";
import {
  createSessionWithRecovery as createSessionWithRecoveryFromPersistence,
  persistSessionStore as persistSessionStoreFromPersistence,
  resolveSessionFilePath,
  resolveSessionMetadata as resolveSessionMetadataFromPersistence,
  type SessionStoreState,
  toSessionStoreLockKey,
} from "./session-persistence.js";

export type AgentRunOptions = {
  runId: string;
  prompt: string;
  systemPrompt?: string;
  sessionKey: string;
  origin?: "user" | "pipeline" | "system";
  memoryScope?: "auto" | "main" | "spoke";
  sessionId?: string;
  model?: string;
  isHeartbeat?: boolean;
  workspaceDir?: string;
  timezone?: string;
  sessionEntriesPath?: string;
  memoryWriteRequested?: boolean;
  onTextDelta?: (delta: string) => void;
  onToolCall?: (name: string, params: unknown) => void;
  isAborted?: () => boolean;
  onTerminalRecord?: (input: {
    runId: string;
    sessionKey: string;
    actionType: "assistant_final" | "assistant_aborted" | "assistant_error";
    ts: string;
    durationMs: number;
    reason?: string;
  }) => void | Promise<void>;
};

export type AgentRunResult = {
  runId: string;
  text: string;
  toolCalls?: Array<{ name: string; result: unknown }>;
  sessionId?: string;
  durationMs?: number;
  modelId?: string;
};

type SessionLike = AgentSessionLike;

type AgentRunnerRuntime = {
  nowMs: () => number;
  wait: (ms: number) => Promise<void>;
  acquireLock: (lockKey: string) => Promise<() => void | Promise<void>>;
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
  }) => Promise<{ session: SessionLike }>;
  readMemoryFiles: typeof readMemoryFiles;
  appendDailyMemory: typeof appendDailyMemory;
  updateLongTermMemory: typeof updateLongTermMemory;
  loadSessionEntryStore: (
    customPath?: string
  ) => Promise<{ path: string; store: SessionEntryStore }>;
  saveSessionEntryStore: (store: SessionEntryStore, customPath?: string) => Promise<string>;
  isWorkspaceWritable: (workspaceDir: string) => Promise<boolean>;
  isModelAvailable: (model?: string) => boolean;
  repairSessionData: (sessionKey: string, sessionEntriesPath?: string) => Promise<boolean>;
  ensureWorkspaceBootstrapFiles: typeof ensureWorkspaceBootstrapFiles;
  loadWorkspaceBootstrapFiles: typeof loadWorkspaceBootstrapFiles;
};

const lockTails = new Map<string, Promise<void>>();

let runtimeOverride: Partial<AgentRunnerRuntime> | null = null;

function createLockAcquirer(): AgentRunnerRuntime["acquireLock"] {
  return async (lockKey: string) => {
    const key = lockKey.trim() || "global";
    const prev = lockTails.get(key) ?? Promise.resolve();
    let releaseNext!: () => void;
    const next = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    lockTails.set(
      key,
      prev.then(() => next)
    );
    await prev;

    return () => {
      releaseNext();
      if (lockTails.get(key) === next) {
        lockTails.delete(key);
      }
    };
  };
}

const defaultRuntime: AgentRunnerRuntime = {
  nowMs: () => Date.now(),
  wait: (ms: number) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  acquireLock: createLockAcquirer(),
  openSessionManager: ({
    sessionKey,
    sessionId,
    sessionEntriesPath,
    sessionEntryStore,
    workspaceDir,
  }) => {
    const entry = upsertSessionEntry(sessionEntryStore, sessionKey);
    const requestedSessionId = sessionId?.trim();
    if (requestedSessionId) {
      entry.sessionId = requestedSessionId;
    }

    const sessionFile =
      typeof entry.sessionFile === "string" && entry.sessionFile.trim()
        ? entry.sessionFile.trim()
        : "";
    if (sessionFile) {
      return SessionManager.open(resolveSessionFilePath(sessionEntriesPath, sessionFile));
    }

    const sessionDir = dirname(sessionEntriesPath);
    return SessionManager.create(workspaceDir, sessionDir);
  },
  createSession: async ({
    sessionManager,
    runId,
    sessionKey,
    model,
    isHeartbeat,
    memoryWriteEnabled,
    memoryScope,
    workspaceDir,
  }) =>
    await createAgentSessionFromSdk({
      sessionManager,
      runId,
      sessionKey,
      model,
      isHeartbeat,
      memoryWriteEnabled,
      memoryScope,
      workspaceDir,
      onWarn: (message, meta) => {
        console.warn("[AgentRunner][MemoryTools]", message, meta ?? {});
      },
    }),
  readMemoryFiles,
  appendDailyMemory,
  updateLongTermMemory,
  loadSessionEntryStore: readSessionEntryStore,
  saveSessionEntryStore: writeSessionEntryStore,
  isWorkspaceWritable: async (workspaceDir) => {
    try {
      await access(workspaceDir, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  isModelAvailable: isAgentModelAvailable,
  repairSessionData: async (sessionKey, sessionEntriesPath) => {
    const state = await readSessionEntryStore(sessionEntriesPath);
    const entry = getSessionEntry(state.store, sessionKey);
    if (!entry) {
      return false;
    }
    const sessionFile =
      typeof entry.sessionFile === "string" && entry.sessionFile.trim()
        ? entry.sessionFile.trim()
        : "";
    if (!sessionFile) {
      return false;
    }
    const absolutePath = resolveSessionFilePath(state.path, sessionFile);
    const backupPath = `${absolutePath}.broken-${Date.now()}`;
    try {
      await rename(absolutePath, backupPath);
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") {
        return false;
      }
      throw error;
    }
    entry.sessionFile = undefined;
    await writeSessionEntryStore(state.store, state.path);
    return true;
  },
  ensureWorkspaceBootstrapFiles,
  loadWorkspaceBootstrapFiles,
};

function getRuntime(): AgentRunnerRuntime {
  return {
    ...defaultRuntime,
    ...(runtimeOverride ?? {}),
  };
}

function withSystemPrompt(prompt: string, systemPrompt: string | undefined): string {
  const cleanedPrompt = prompt.trim();
  const cleanedSystemPrompt = typeof systemPrompt === "string" ? systemPrompt.trim() : "";
  if (!cleanedSystemPrompt) {
    return cleanedPrompt;
  }
  if (!cleanedPrompt) {
    return cleanedSystemPrompt;
  }
  return `${cleanedSystemPrompt}\n\n${cleanedPrompt}`;
}

function classifyError(
  error: unknown
): "transient" | "context_overflow" | "model_unavailable" | "unknown" {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("model") && message.includes("unavailable")) {
    return "model_unavailable";
  }
  if (
    message.includes("context") &&
    (message.includes("length") ||
      message.includes("window") ||
      message.includes("too long") ||
      message.includes("max token"))
  ) {
    return "context_overflow";
  }
  if (
    message.includes("timeout") ||
    message.includes("temporar") ||
    message.includes("econn") ||
    message.includes("429") ||
    message.includes("503")
  ) {
    return "transient";
  }
  return "unknown";
}

function shrinkPrompt(prompt: string): string {
  if (prompt.length <= 200) {
    return prompt;
  }
  const keep = Math.floor(prompt.length * 0.7);
  return `[context trimmed]\n${prompt.slice(prompt.length - keep)}`;
}

async function promptWithRetry(params: {
  session: SessionLike;
  prompt: string;
  runtime: AgentRunnerRuntime;
  compactionEnabled: boolean;
  onCompactionCompleted?: () => void;
  getCompactionCount?: () => number;
}): Promise<void> {
  let prompt = params.prompt;
  let attempts = 0;

  for (;;) {
    try {
      await params.session.prompt(prompt);
      return;
    } catch (error) {
      const category = classifyError(error);
      if (category === "transient" && attempts < 1) {
        attempts += 1;
        await params.runtime.wait(2500);
        continue;
      }
      if (category === "context_overflow" && attempts < 1) {
        attempts += 1;
        if (params.compactionEnabled && typeof params.session.compact === "function") {
          const before = params.getCompactionCount?.();
          await params.session.compact();
          const after = params.getCompactionCount?.();
          if (before === undefined || after === undefined || after <= before) {
            params.onCompactionCompleted?.();
          }
          continue;
        }
        prompt = shrinkPrompt(prompt);
        continue;
      }
      throw error;
    }
  }
}

async function runPreCompactionMemoryFlush(params: {
  session: SessionLike;
  runtime: AgentRunnerRuntime;
  sessionKey: string;
  isHeartbeat: boolean;
  memoryScope: "main" | "spoke";
  workspaceDir: string;
  settings: ReturnType<typeof resolveCompactionRuntimeSettings>["memoryFlush"];
  metadata: ReturnType<typeof resolveSessionCompactionMetadata>;
  compactionTracker: CompactionEventTracker;
  setSilentTurn: (silent: boolean) => void;
  waitForSettledMemoryWrites: () => Promise<void>;
}): Promise<
  | {
      executedAtIso: string;
      compactionCountAtFlush: number;
    }
  | undefined
> {
  const contextUsage = params.session.getContextUsage?.();
  params.compactionTracker.setContextUsage(contextUsage);
  const workspaceWritable = await params.runtime.isWorkspaceWritable(params.workspaceDir);
  const decision = shouldRunPreCompactionMemoryFlush({
    settings: params.settings,
    metadata: params.metadata,
    contextUsage,
    isMainSession: params.memoryScope === "main",
    isHeartbeat: params.isHeartbeat,
    workspaceWritable,
  });
  if (!decision.shouldRun) {
    return undefined;
  }

  params.setSilentTurn(true);
  try {
    await params.session.prompt(
      withSystemPrompt(params.settings.prompt, params.settings.systemPrompt)
    );
    await params.waitForSettledMemoryWrites();
    params.compactionTracker.markFlushTriggered();
    return {
      executedAtIso: new Date(params.runtime.nowMs()).toISOString(),
      compactionCountAtFlush: params.compactionTracker.getCompactionCount(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[AgentRunner][MemoryFlush] flush turn failed", {
      sessionKey: params.sessionKey,
      reason: message,
    });
    return undefined;
  } finally {
    params.setSilentTurn(false);
  }
}

async function runAgentInternal(opts: AgentRunOptions): Promise<AgentRunResult> {
  const runtime = getRuntime();
  const startedAtMs = runtime.nowMs();
  const context = resolveAgentRunContext(opts);
  const auditScope: AgentAuditScope = {
    runId: context.runId,
    sessionKey: context.sessionKey,
  };
  auditRunStart({
    scope: auditScope,
    origin: context.origin,
    modelId: context.model,
  });
  let terminalActionType: "assistant_final" | "assistant_aborted" | "assistant_error" =
    "assistant_error";
  let terminalReason: string | undefined;

  let releaseLock: (() => void | Promise<void>) | undefined;
  let session: SessionLike | undefined;
  let unsubscribe: (() => void) | undefined;
  let output = "";
  let toolCalls: Array<{ name: string; result: unknown }> = [];
  let sessionMetadata: { sessionId?: string; sessionFile?: string; modelId?: string } | null = null;
  let previousUpdatedAt: string | null = null;
  let sessionStoreState: SessionStoreState | null = null;
  let compactionTracker = createCompactionEventTracker(0);
  let memoryFlushMetadata:
    | {
        executedAtIso: string;
        compactionCountAtFlush: number;
      }
    | undefined;
  let isSilentTurn = false;

  try {
    if (context.model && !runtime.isModelAvailable(context.model)) {
      throw new Error(`model unavailable: ${context.model}`);
    }

    const compactionSettings = resolveCompactionRuntimeSettings();
    if (context.origin === "user") {
      await runtime.ensureWorkspaceBootstrapFiles(context.workspaceDir);
    }
    const memory =
      context.memoryScope === "main"
        ? await runtime.readMemoryFiles({
            workspaceDir: context.workspaceDir,
            timezone: context.timezone,
            auditScope,
          })
        : { longTerm: null, daily: null, yesterday: null };

    const bootstrapFiles = shouldInjectBootstrapContext(context)
      ? await runtime.loadWorkspaceBootstrapFiles(context.workspaceDir)
      : undefined;
    const prompt = buildAgentPrompt({
      basePrompt: context.prompt,
      systemPrompt: context.systemPrompt,
      memory: {
        longTerm: memory.longTerm,
        daily: memory.daily,
      },
      bootstrapFiles,
      onBootstrapWarn: (message, meta) => {
        console.warn("[AgentRunner][BootstrapContext]", message, {
          sessionKey: context.sessionKey,
          origin: context.origin,
          ...(meta ?? {}),
        });
      },
    });

    releaseLock = await runtime.acquireLock(toSessionStoreLockKey(context.sessionEntriesPath));
    sessionStoreState = await runtime.loadSessionEntryStore(context.sessionEntriesPath);
    const sessionEntry = getSessionEntry(sessionStoreState.store, context.sessionKey);
    const sessionCompactionMetadata = resolveSessionCompactionMetadata(sessionEntry);
    compactionTracker = createCompactionEventTracker(sessionCompactionMetadata.compactionCount);
    const createdState = await createSessionWithRecoveryFromPersistence({
      runtime,
      sessionKey: context.sessionKey,
      sessionId: context.sessionId,
      sessionEntriesPath: context.sessionEntriesPath,
      sessionStoreState,
      workspaceDir: context.workspaceDir,
      model: context.model,
      isHeartbeat: context.isHeartbeat,
      memoryWriteEnabled: context.memoryWriteEnabled,
      memoryScope: context.memoryScope,
      runId: context.runId,
    });
    sessionStoreState = createdState.sessionStoreState;
    previousUpdatedAt = createdState.previousUpdatedAt;
    const created = createdState.created;
    session = created.session;

    const subscribed = createAgentEventSubscriber({
      session: created.session,
      runtime,
      memoryWriteEnabled: context.memoryWriteEnabled,
      workspaceDir: context.workspaceDir,
      timezone: context.timezone,
      auditScope,
      compactionTracker,
      isSilentTurn: () => isSilentTurn,
      onTextDelta: opts.onTextDelta,
      onToolCall: opts.onToolCall,
    });
    unsubscribe = subscribed.unsubscribe;

    memoryFlushMetadata = await runPreCompactionMemoryFlush({
      session: created.session,
      runtime,
      sessionKey: context.sessionKey,
      isHeartbeat: context.isHeartbeat,
      memoryScope: context.memoryScope,
      workspaceDir: context.workspaceDir,
      settings: compactionSettings.memoryFlush,
      metadata: sessionCompactionMetadata,
      compactionTracker,
      setSilentTurn: (silent) => {
        isSilentTurn = silent;
      },
      waitForSettledMemoryWrites: subscribed.waitForSettledMemoryWrites,
    });

    await promptWithRetry({
      session: created.session,
      prompt,
      runtime,
      compactionEnabled: compactionSettings.compactionEnabled,
      onCompactionCompleted: () => {
        compactionTracker.markCompactionCompleted("overflow");
      },
      getCompactionCount: () => compactionTracker.getCompactionCount(),
    });

    await subscribed.waitForSettledMemoryWrites();
    compactionTracker.setContextUsage(created.session.getContextUsage?.());

    const durationMs = Math.max(0, runtime.nowMs() - startedAtMs);
    output = subscribed.output.text;
    toolCalls = subscribed.toolCalls;
    sessionMetadata = resolveSessionMetadataFromPersistence(created.session);

    if (sessionStoreState && sessionMetadata) {
      await persistSessionStoreFromPersistence({
        runtime,
        sessionStoreState,
        sessionKey: context.sessionKey,
        sessionMetadata,
        explicitSessionId: context.sessionId?.trim(),
        nowIso: new Date(runtime.nowMs()).toISOString(),
        isHeartbeat: context.isHeartbeat,
        previousUpdatedAt,
        compactionTracker,
        memoryFlushMetadata,
      });
    }

    terminalActionType = "assistant_final";
    return {
      runId: context.runId,
      text: output.trim(),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      sessionId: context.sessionId?.trim() || sessionMetadata?.sessionId,
      durationMs,
      modelId: sessionMetadata?.modelId ?? context.model,
    };
  } catch (error) {
    terminalReason = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    try {
      unsubscribe?.();
    } catch {
      // ignore cleanup error
    }
    try {
      session?.dispose();
    } catch {
      // ignore cleanup error
    }
    if (releaseLock) {
      await releaseLock();
    }
    const effectiveActionType = opts.isAborted?.() ? "assistant_aborted" : terminalActionType;
    const durationMs = Math.max(0, runtime.nowMs() - startedAtMs);
    const ts = new Date(runtime.nowMs()).toISOString();
    const runStatus =
      effectiveActionType === "assistant_final"
        ? "ok"
        : effectiveActionType === "assistant_aborted"
          ? "aborted"
          : "error";
    auditRunEnd({
      scope: auditScope,
      status: runStatus,
      durationMs,
      modelId: sessionMetadata?.modelId ?? context.model,
      error: terminalReason,
    });
    if (opts.onTerminalRecord) {
      try {
        await opts.onTerminalRecord({
          runId: context.runId,
          sessionKey: context.sessionKey,
          actionType: effectiveActionType,
          ts,
          durationMs,
          reason: terminalReason,
        });
      } catch (error) {
        console.warn("[AgentRunner] terminal record callback failed", {
          runId: context.runId,
          sessionKey: context.sessionKey,
          actionType: effectiveActionType,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

const defaultAgentRunExecutor = new AgentRunExecutor(runAgentInternal);

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  return await defaultAgentRunExecutor.run(opts);
}

export function setAgentRunnerRuntimeForTest(runtime: Partial<AgentRunnerRuntime> | null): void {
  runtimeOverride = runtime;
}

export function resetAgentRunnerForTest(): void {
  runtimeOverride = null;
  lockTails.clear();
}
