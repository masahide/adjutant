import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  readOnlyTools,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { appendDailyMemory, updateLongTermMemory } from "./memory-writer.js";
import { readMemoryFiles } from "./memory-reader.js";
import {
  resolveSessionEntriesPath,
  readSessionEntryStore,
  writeSessionEntryStore,
  getSessionEntry,
  upsertSessionEntry,
  parseIsoMs,
  type SessionEntryStore,
} from "./session-entry-store.js";

export type AgentRunOptions = {
  runId: string;
  prompt: string;
  systemPrompt?: string;
  sessionKey: string;
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
    workspaceDir: string;
  }) => Promise<{ session: SessionLike }>;
  readMemoryFiles: typeof readMemoryFiles;
  appendDailyMemory: typeof appendDailyMemory;
  updateLongTermMemory: typeof updateLongTermMemory;
  loadSessionEntryStore: (
    customPath?: string
  ) => Promise<{ path: string; store: SessionEntryStore }>;
  saveSessionEntryStore: (store: SessionEntryStore, customPath?: string) => Promise<string>;
  isModelAvailable: (model?: string) => boolean;
  repairSessionData: (sessionKey: string, sessionEntriesPath?: string) => Promise<boolean>;
};

const lockTails = new Map<string, Promise<void>>();

let runtimeOverride: Partial<AgentRunnerRuntime> | null = null;

function normalizeSessionKey(value: string | undefined): string {
  if (typeof value !== "string") {
    return "main";
  }
  const trimmed = value.trim();
  return trimmed || "main";
}

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
    const customTools = memoryWriteEnabled ? [createMemoryWriteToolDefinition()] : [];

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
  const timezone = opts.timezone?.trim();
  return timezone || process.env.ADJUTANT_TZ || "Asia/Tokyo";
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

  const memory = await runtime.readMemoryFiles({
    workspaceDir,
    timezone,
  });

  let prompt = withSystemPrompt(opts.prompt, opts.systemPrompt);
  prompt = appendMemoryContext(prompt, {
    longTerm: memory.longTerm,
    daily: memory.daily,
  });

  let releaseLock: (() => void | Promise<void>) | undefined;
  let session: SessionLike | undefined;
  let unsubscribe: (() => void) | undefined;
  let output = "";
  const toolCalls: Array<{ name: string; result: unknown }> = [];
  const memoryWriteTasks: Promise<void>[] = [];
  let previousUpdatedAt: string | null = null;
  let sessionStoreState: { path: string; store: SessionEntryStore } | null = null;

  try {
    releaseLock = await runtime.acquireLock(toSessionStoreLockKey(sessionEntriesPath));
    sessionStoreState = await runtime.loadSessionEntryStore(sessionEntriesPath);
    previousUpdatedAt = getEntryUpdatedAt(sessionStoreState.store, sessionKey);

    let sessionManager = runtime.openSessionManager({
      sessionKey,
      sessionId: opts.sessionId,
      sessionEntriesPath,
      sessionEntryStore: sessionStoreState.store,
      workspaceDir,
    });
    let created: { session: SessionLike };
    try {
      created = await runtime.createSession({
        sessionManager,
        model: opts.model,
        isHeartbeat: opts.isHeartbeat,
        memoryWriteEnabled,
        workspaceDir,
      });
    } catch (error) {
      if (!isSessionCorruptionError(error)) {
        throw error;
      }
      const repaired = await runtime.repairSessionData(sessionKey, sessionEntriesPath);
      if (!repaired) {
        throw error;
      }
      sessionStoreState = await runtime.loadSessionEntryStore(sessionEntriesPath);
      previousUpdatedAt = getEntryUpdatedAt(sessionStoreState.store, sessionKey);
      sessionManager = runtime.openSessionManager({
        sessionKey,
        sessionId: opts.sessionId,
        sessionEntriesPath,
        sessionEntryStore: sessionStoreState.store,
        workspaceDir,
      });
      created = await runtime.createSession({
        sessionManager,
        model: opts.model,
        isHeartbeat: opts.isHeartbeat,
        memoryWriteEnabled,
        workspaceDir,
      });
    }
    session = created.session;

    unsubscribe = created.session.subscribe((event) => {
      const delta = tryGetTextDelta(event);
      if (delta) {
        output += delta;
        opts.onTextDelta?.(delta);
      }

      const toolCall = tryGetToolCall(event);
      if (toolCall) {
        if (toolCall.name === "memory_write" && !memoryWriteEnabled) {
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
                await runtime.appendDailyMemory(parsed.content, { workspaceDir, timezone });
              } else {
                await runtime.updateLongTermMemory(parsed.content, { workspaceDir, timezone });
              }
            })()
          );
        }
        opts.onToolCall?.(toolCall.name, toolCall.args);
      }

      const toolResult = tryGetToolResult(event);
      if (!toolResult) {
        return;
      }
      if (toolResult.name === "memory_write" && !memoryWriteEnabled) {
        return;
      }
      toolCalls.push(toolResult);
    });

    let attempts = 0;
    for (;;) {
      try {
        await created.session.prompt(prompt);
        break;
      } catch (error) {
        const category = classifyError(error);
        if (category === "transient" && attempts < 1) {
          attempts += 1;
          await runtime.wait(2500);
          continue;
        }
        if (category === "context_overflow" && attempts < 1) {
          attempts += 1;
          prompt = shrinkPrompt(prompt);
          continue;
        }
        throw error;
      }
    }

    if (memoryWriteTasks.length > 0) {
      await Promise.all(memoryWriteTasks);
    }

    const durationMs = Math.max(0, runtime.nowMs() - startedAtMs);

    const sessionMetadata = resolveSessionMetadata(created.session);

    if (sessionStoreState) {
      const entry = upsertSessionEntry(sessionStoreState.store, sessionKey);
      const explicitSessionId = opts.sessionId?.trim();
      const sessionId = explicitSessionId || sessionMetadata.sessionId;
      if (sessionId) {
        entry.sessionId = sessionId;
      }
      if (sessionMetadata.sessionFile) {
        entry.sessionFile = relativizeSessionFilePath(
          sessionStoreState.path,
          sessionMetadata.sessionFile
        );
      }
      entry.updatedAt = resolveUpdatedAt({
        nowIso: new Date(runtime.nowMs()).toISOString(),
        isHeartbeat: opts.isHeartbeat,
        previousUpdatedAt,
      });
      await runtime.saveSessionEntryStore(sessionStoreState.store, sessionStoreState.path);
    }

    return {
      runId: opts.runId,
      text: output.trim(),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      sessionId: opts.sessionId?.trim() || sessionMetadata.sessionId,
      durationMs,
      modelId: sessionMetadata.modelId ?? opts.model,
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
