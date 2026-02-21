import {
  AuthStorage,
  type ContextUsage,
  createAgentSession,
  ModelRegistry,
  readOnlyTools,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { constants as fsConstants } from "node:fs";
import { access, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { appendDailyMemory, updateLongTermMemory } from "./memory-writer.js";
import { readMemoryFiles } from "./memory-reader.js";
import { normalizeSessionKey, normalizeTimezone } from "./shared-normalizers.js";
import {
  createCompactionEventTracker,
  resolveCompactionRuntimeSettings,
  resolveSessionCompactionMetadata,
  shouldRunPreCompactionMemoryFlush,
  type CompactionEventTracker,
} from "./compaction-runtime.js";
import {
  resolveSessionEntriesPath,
  readSessionEntryStore,
  writeSessionEntryStore,
  getSessionEntry,
  upsertSessionEntry,
  parseIsoMs,
  type SessionEntryStore,
} from "./session-entry-store.js";
import { createMemoryToolDefinitions } from "./memory-search/index.js";

export type AgentRunOptions = {
  runId: string;
  prompt: string;
  systemPrompt?: string;
  sessionKey: string;
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
};

export type AgentRunResult = {
  runId: string;
  text: string;
  toolCalls?: Array<{ name: string; result: unknown }>;
  sessionId?: string;
  durationMs?: number;
  modelId?: string;
};

type UnknownRecord = Record<string, unknown>;

type SessionLike = {
  subscribe: (listener: (event: unknown) => void) => () => void;
  prompt: (text: string) => Promise<void>;
  getContextUsage?: () => ContextUsage | undefined;
  compact?: (customInstructions?: string) => Promise<unknown>;
  dispose: () => void;
  sessionId?: string;
  sessionFile?: string;
  model?: unknown;
};

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
};

const lockTails = new Map<string, Promise<void>>();

let runtimeOverride: Partial<AgentRunnerRuntime> | null = null;

function resolveSessionFilePath(sessionEntriesPath: string, sessionFile: string): string {
  if (isAbsolute(sessionFile)) {
    return sessionFile;
  }
  return join(dirname(sessionEntriesPath), sessionFile);
}

function toSessionStoreLockKey(sessionEntriesPath: string): string {
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

function parseModelSpecifier(model: string): { provider: string; modelId: string } | null {
  const specifier = model.trim();
  if (!specifier) {
    return null;
  }
  const firstSlash = specifier.indexOf("/");
  if (firstSlash <= 0 || firstSlash === specifier.length - 1) {
    return null;
  }
  const provider = specifier.slice(0, firstSlash).trim();
  const modelId = specifier.slice(firstSlash + 1).trim();
  if (!provider || !modelId) {
    return null;
  }
  return { provider, modelId };
}

function resolveModelSelection(
  modelRegistry: ModelRegistry,
  model: string | undefined
): { matched: boolean; model?: unknown; provider?: string; modelId?: string } {
  const specifier = model?.trim();
  if (!specifier) {
    return { matched: false };
  }

  const explicit = parseModelSpecifier(specifier);
  if (explicit) {
    const found = modelRegistry.find(explicit.provider, explicit.modelId);
    if (found) {
      return {
        matched: true,
        model: found,
        provider: found.provider,
        modelId: found.id,
      };
    }
    return {
      matched: false,
      provider: explicit.provider,
      modelId: explicit.modelId,
    };
  }

  const byId = modelRegistry
    .getAll()
    .filter((candidate) => candidate.id.toLowerCase() === specifier.toLowerCase());
  if (byId.length === 0) {
    return {
      matched: false,
      modelId: specifier,
    };
  }
  const selected = byId[0];
  return {
    matched: true,
    model: selected,
    provider: selected.provider,
    modelId: selected.id,
  };
}

function createMemoryWriteToolDefinition(): ToolDefinition {
  return {
    name: "memory_write",
    label: "Memory Write",
    description: "Persist notable user preference or context into assistant memory.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", minLength: 1 },
        scope: { enum: ["daily", "long-term"] },
      },
      required: ["content"],
      additionalProperties: false,
    } as never,
    execute: async (_toolCallId, params) => {
      const record = params as { scope?: unknown; content?: unknown };
      const scope = record.scope === "long-term" ? "long-term" : "daily";
      const content = typeof record.content === "string" ? record.content : "";
      return {
        content: [{ type: "text", text: `memory_write accepted (${scope})` }],
        details: { scope, content },
      };
    },
  };
}

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

    const sessionDir = join(dirname(sessionEntriesPath), "sessions");
    return SessionManager.create(workspaceDir, sessionDir);
  },
  createSession: async ({
    sessionManager,
    model,
    isHeartbeat,
    memoryWriteEnabled,
    memoryScope,
    workspaceDir,
  }) => {
    const authStorage = new AuthStorage();
    const modelRegistry = new ModelRegistry(authStorage);
    const resolvedModel = resolveModelSelection(modelRegistry, model);
    const settingsOverrides: { defaultProvider?: string; defaultModel?: string } = {};
    if (resolvedModel.provider) {
      settingsOverrides.defaultProvider = resolvedModel.provider;
    }
    if (resolvedModel.modelId) {
      settingsOverrides.defaultModel = resolvedModel.modelId;
    }
    const settingsManager = SettingsManager.inMemory(settingsOverrides);
    const customTools: ToolDefinition[] = [];
    if (memoryScope === "main") {
      customTools.push(
        ...createMemoryToolDefinitions({
          workspaceDir,
          onWarn: (message, meta) => {
            console.warn("[AgentRunner][MemoryTools]", message, meta ?? {});
          },
        })
      );
    }
    if (memoryWriteEnabled) {
      customTools.push(createMemoryWriteToolDefinition());
    }

    const created = await createAgentSession({
      cwd: workspaceDir,
      sessionManager: sessionManager as SessionManager,
      settingsManager,
      modelRegistry,
      model: resolvedModel.model as never,
      tools: isHeartbeat ? readOnlyTools : undefined,
      customTools,
    });
    return {
      session: created.session as SessionLike,
    };
  },
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
  isModelAvailable: (model) => {
    const specifier = model?.trim();
    if (!specifier) {
      return true;
    }
    const modelRegistry = new ModelRegistry(new AuthStorage());
    return resolveModelSelection(modelRegistry, specifier).matched;
  },
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

function appendMemoryContext(
  prompt: string,
  memory: { longTerm: string | null; daily: string | null }
): string {
  const sections: string[] = [];
  const longTerm = memory.longTerm?.trim();
  if (longTerm) {
    sections.push(`## Memory\n${longTerm}`);
  }
  const daily = memory.daily?.trim();
  if (daily) {
    sections.push(`## Daily Memory\n${daily}`);
  }
  if (sections.length === 0) {
    return prompt;
  }
  return `${sections.join("\n\n")}\n\n${prompt}`;
}

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as UnknownRecord;
}

function tryGetTextDelta(event: unknown): string | null {
  const top = asRecord(event);
  if (!top || top.type !== "message_update") {
    return null;
  }
  const assistantMessageEvent = asRecord(top.assistantMessageEvent);
  if (!assistantMessageEvent || assistantMessageEvent.type !== "text_delta") {
    return null;
  }
  const delta = assistantMessageEvent.delta;
  return typeof delta === "string" ? delta : null;
}

function tryGetToolCall(event: unknown): { name: string; args: unknown } | null {
  const top = asRecord(event);
  if (!top || top.type !== "tool_execution_start") {
    return null;
  }
  const toolName = top.toolName;
  if (typeof toolName !== "string") {
    return null;
  }
  return {
    name: toolName,
    args: top.args,
  };
}

function tryGetToolResult(event: unknown): { name: string; result: unknown } | null {
  const top = asRecord(event);
  if (!top || top.type !== "tool_execution_end") {
    return null;
  }
  const toolName = top.toolName;
  if (typeof toolName !== "string") {
    return null;
  }
  return {
    name: toolName,
    result: top.result,
  };
}

function getEntryUpdatedAt(store: SessionEntryStore, sessionKey: string): string | null {
  const entry = getSessionEntry(store, sessionKey);
  if (!entry) {
    return null;
  }
  return typeof entry.updatedAt === "string" ? entry.updatedAt : null;
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

function resolveSessionMetadata(session: SessionLike): {
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

function shouldEnableMemoryWrite(opts: AgentRunOptions): boolean {
  if (opts.isHeartbeat) {
    return false;
  }
  if (typeof opts.memoryWriteRequested === "boolean") {
    return opts.memoryWriteRequested;
  }
  return /覚えておいて|覚えといて|remember\s+(this|that)|remember\b/i.test(opts.prompt);
}

function resolveMemoryScope(opts: AgentRunOptions, sessionKey: string): "main" | "spoke" {
  if (opts.memoryScope === "main" || opts.memoryScope === "spoke") {
    return opts.memoryScope;
  }
  return sessionKey === "main" ? "main" : "spoke";
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

function shrinkPrompt(prompt: string): string {
  if (prompt.length <= 200) {
    return prompt;
  }
  const keep = Math.floor(prompt.length * 0.7);
  return `[context trimmed]\n${prompt.slice(prompt.length - keep)}`;
}

function resolveTimezone(opts: AgentRunOptions): string {
  return normalizeTimezone(opts.timezone);
}

function resolveWorkspaceDir(opts: AgentRunOptions): string {
  const workspace = opts.workspaceDir?.trim();
  return workspace || process.cwd();
}

function parseMemoryWriteArgs(
  args: unknown
): { scope: "daily" | "long-term"; content: string } | null {
  const record = asRecord(args);
  if (!record) {
    return null;
  }
  const rawContent =
    typeof record.content === "string"
      ? record.content
      : typeof record.text === "string"
        ? record.text
        : "";
  const content = rawContent.trim();
  if (!content) {
    return null;
  }

  const rawScope =
    typeof record.scope === "string"
      ? record.scope.trim().toLowerCase()
      : typeof record.target === "string"
        ? record.target.trim().toLowerCase()
        : "daily";
  if (rawScope === "long-term" || rawScope === "longterm" || rawScope === "memory") {
    return { scope: "long-term", content };
  }
  return { scope: "daily", content };
}

function parseNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int >= 0 ? int : null;
}

type SessionStoreState = { path: string; store: SessionEntryStore };

async function createSessionWithRecovery(params: {
  runtime: AgentRunnerRuntime;
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
  created: { session: SessionLike };
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

function subscribeSessionEvents(params: {
  session: SessionLike;
  opts: AgentRunOptions;
  runtime: AgentRunnerRuntime;
  memoryWriteEnabled: boolean;
  workspaceDir: string;
  timezone: string;
  compactionTracker: CompactionEventTracker;
  isSilentTurn: () => boolean;
}): {
  unsubscribe: () => void;
  output: { text: string };
  toolCalls: Array<{ name: string; result: unknown }>;
  memoryWriteTasks: Promise<void>[];
  waitForSettledMemoryWrites: () => Promise<void>;
} {
  const output = { text: "" };
  const toolCalls: Array<{ name: string; result: unknown }> = [];
  const memoryWriteTasks: Promise<void>[] = [];
  let settledMemoryTaskCount = 0;

  const unsubscribe = params.session.subscribe((event) => {
    params.compactionTracker.onEvent(event);

    const delta = tryGetTextDelta(event);
    if (delta && !params.isSilentTurn()) {
      output.text += delta;
      params.opts.onTextDelta?.(delta);
    }

    const toolCall = tryGetToolCall(event);
    if (toolCall) {
      if (toolCall.name === "memory_write" && !params.memoryWriteEnabled) {
        return;
      }
      if (toolCall.name === "memory_write") {
        const parsed = parseMemoryWriteArgs(toolCall.args);
        if (!parsed) {
          return;
        }
        memoryWriteTasks.push(
          (async () => {
            if (parsed.scope === "daily") {
              await params.runtime.appendDailyMemory(parsed.content, {
                workspaceDir: params.workspaceDir,
                timezone: params.timezone,
              });
            } else {
              await params.runtime.updateLongTermMemory(parsed.content, {
                workspaceDir: params.workspaceDir,
                timezone: params.timezone,
              });
            }
          })()
        );
      }
      if (!params.isSilentTurn()) {
        params.opts.onToolCall?.(toolCall.name, toolCall.args);
      }
    }

    const toolResult = tryGetToolResult(event);
    if (!toolResult) {
      return;
    }
    if (toolResult.name === "memory_write" && !params.memoryWriteEnabled) {
      return;
    }
    if (params.isSilentTurn()) {
      return;
    }
    toolCalls.push(toolResult);
  });

  return {
    unsubscribe,
    output,
    toolCalls,
    memoryWriteTasks,
    waitForSettledMemoryWrites: async () => {
      const pending = memoryWriteTasks.slice(settledMemoryTaskCount);
      settledMemoryTaskCount = memoryWriteTasks.length;
      if (pending.length > 0) {
        await Promise.all(pending);
      }
    },
  };
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

async function persistSessionStore(params: {
  runtime: AgentRunnerRuntime;
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

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const runtime = getRuntime();
  const startedAtMs = runtime.nowMs();

  if (opts.model && !runtime.isModelAvailable(opts.model)) {
    throw new Error(`model unavailable: ${opts.model}`);
  }

  const sessionKey = normalizeSessionKey(opts.sessionKey);
  const workspaceDir = resolveWorkspaceDir(opts);
  const timezone = resolveTimezone(opts);
  const sessionEntriesPath = resolveSessionEntriesPath(opts.sessionEntriesPath);
  const memoryWriteEnabled = shouldEnableMemoryWrite(opts);
  const memoryScope = resolveMemoryScope(opts, sessionKey);
  const compactionSettings = resolveCompactionRuntimeSettings();
  const memory =
    memoryScope === "main"
      ? await runtime.readMemoryFiles({
          workspaceDir,
          timezone,
        })
      : { longTerm: null, daily: null, yesterday: null };

  let prompt = withSystemPrompt(opts.prompt, opts.systemPrompt);
  prompt = appendMemoryContext(prompt, {
    longTerm: memory.longTerm,
    daily: memory.daily,
  });

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
    releaseLock = await runtime.acquireLock(toSessionStoreLockKey(sessionEntriesPath));
    sessionStoreState = await runtime.loadSessionEntryStore(sessionEntriesPath);
    const sessionEntry = getSessionEntry(sessionStoreState.store, sessionKey);
    const sessionCompactionMetadata = resolveSessionCompactionMetadata(sessionEntry);
    compactionTracker = createCompactionEventTracker(sessionCompactionMetadata.compactionCount);
    const createdState = await createSessionWithRecovery({
      runtime,
      sessionKey,
      sessionId: opts.sessionId,
      sessionEntriesPath,
      sessionStoreState,
      workspaceDir,
      model: opts.model,
      isHeartbeat: opts.isHeartbeat,
      memoryWriteEnabled,
      memoryScope,
    });
    sessionStoreState = createdState.sessionStoreState;
    previousUpdatedAt = createdState.previousUpdatedAt;
    const created = createdState.created;
    session = created.session;

    const subscribed = subscribeSessionEvents({
      session: created.session,
      opts,
      runtime,
      memoryWriteEnabled,
      workspaceDir,
      timezone,
      compactionTracker,
      isSilentTurn: () => isSilentTurn,
    });
    unsubscribe = subscribed.unsubscribe;

    memoryFlushMetadata = await runPreCompactionMemoryFlush({
      session: created.session,
      runtime,
      sessionKey,
      isHeartbeat: Boolean(opts.isHeartbeat),
      memoryScope,
      workspaceDir,
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
    sessionMetadata = resolveSessionMetadata(created.session);

    if (sessionStoreState && sessionMetadata) {
      await persistSessionStore({
        runtime,
        sessionStoreState,
        sessionKey,
        sessionMetadata,
        explicitSessionId: opts.sessionId?.trim(),
        nowIso: new Date(runtime.nowMs()).toISOString(),
        isHeartbeat: opts.isHeartbeat,
        previousUpdatedAt,
        compactionTracker,
        memoryFlushMetadata,
      });
    }

    return {
      runId: opts.runId,
      text: output.trim(),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      sessionId: opts.sessionId?.trim() || sessionMetadata?.sessionId,
      durationMs,
      modelId: sessionMetadata?.modelId ?? opts.model,
    };
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
  }
}

export function setAgentRunnerRuntimeForTest(runtime: Partial<AgentRunnerRuntime> | null): void {
  runtimeOverride = runtime;
}

export function resetAgentRunnerForTest(): void {
  runtimeOverride = null;
  lockTails.clear();
}
