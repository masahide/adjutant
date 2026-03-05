import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { buildBootstrapContextFiles, renderProjectContext } from "./bootstrap-context.js";
import {
  createCompactionEventTracker,
  resolveCompactionRuntimeSettings,
  resolveSessionCompactionMetadata,
  shouldRunPreCompactionMemoryFlush,
} from "./compaction-runtime.js";
import { SessionCompactionStore, type SessionCompactionEntry } from "./session-compaction-store.js";
import {
  ensureWorkspaceBootstrapFiles,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
} from "./workspace-bootstrap.js";
import type { PiAgentSessionLike } from "./agent-session-factory.js";

export type LegacyToolCallEvent =
  | {
      event: "tool_execution_start";
      toolCallId?: string;
      name: string;
      title?: string;
      kind?: "read" | "edit" | "execute" | "search";
      rawInput?: unknown;
      startedAt?: string;
    }
  | {
      event: "tool_execution_end";
      toolCallId?: string;
      name: string;
      status?: "ok" | "error";
      rawOutput?: unknown;
      error?: string;
      endedAt?: string;
    };

export interface TerminalRecordEvent {
  runId: string;
  sessionKey: string;
  actionType: string;
  status?: "pending-timeline" | "recorded";
  timelineOffset?: number;
  ts?: string;
}

export interface AgentRunCallbacks {
  onTextDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  onToolCall?: (event: LegacyToolCallEvent | string, params?: unknown) => void;
  onTerminalRecord?: (record: TerminalRecordEvent) => void;
}

export interface AgentRunOptions {
  runId: string;
  prompt: string;
  sessionKey: string;
  sessionId?: string;
  memoryScope?: "main" | "spoke";
  memoryWriteEnabled?: boolean;
  origin?: "user" | "system";
  isHeartbeat?: boolean;
  signal?: AbortSignal;
  callbacks?: AgentRunCallbacks;
}

export interface AgentRunResult {
  runId: string;
  text: string;
  stopReason?: string;
}

export type AgentRunner = (options: AgentRunOptions) => Promise<AgentRunResult>;

type AgentRunnerRuntime = {
  isExternalRunnerEnabled: () => boolean;
  createSession: (input: {
    cwd: string;
    model?: string;
    memoryScope?: "main" | "spoke";
    memoryWriteEnabled?: boolean;
    stateDir?: string;
    isHeartbeat?: boolean;
  }) => Promise<{ session: PiAgentSessionLike }>;
  ensureWorkspaceBootstrapFiles: (workspaceDir: string) => Promise<unknown>;
  loadWorkspaceBootstrapFiles: (workspaceDir: string) => Promise<WorkspaceBootstrapFile[]>;
  isWorkspaceWritable: (workspaceDir: string) => Promise<boolean>;
  loadCompactionEntry: (params: {
    sessionKey: string;
    stateDir?: string;
  }) => Promise<SessionCompactionEntry | undefined>;
  saveCompactionEntry: (params: {
    sessionKey: string;
    stateDir?: string;
    entry: Partial<SessionCompactionEntry>;
  }) => Promise<void>;
  cwd: () => string;
};

const compactionStoreCache = new Map<string, SessionCompactionStore>();
const compactionStoreInitCache = new Map<string, Promise<void>>();

async function resolveCompactionStore(stateDir?: string): Promise<SessionCompactionStore> {
  const resolvedStateDir =
    stateDir !== undefined && stateDir.trim().length > 0
      ? resolve(stateDir.trim())
      : resolve(homedir(), ".adjutant");

  let store = compactionStoreCache.get(resolvedStateDir);
  if (store === undefined) {
    store = SessionCompactionStore.fromStateDir(resolvedStateDir);
    compactionStoreCache.set(resolvedStateDir, store);
  }

  let initialized = compactionStoreInitCache.get(resolvedStateDir);
  if (initialized === undefined) {
    initialized = store.initialize();
    compactionStoreInitCache.set(resolvedStateDir, initialized);
  }
  await initialized;

  return store;
}

const defaultRuntime: AgentRunnerRuntime = {
  isExternalRunnerEnabled: () => {
    return (
      typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.trim().length > 0
    );
  },
  createSession: async ({ cwd, model, memoryScope, memoryWriteEnabled, stateDir, isHeartbeat }) => {
    const module = await import("./agent-session-factory.js");
    return await module.createPiAgentSession({
      cwd,
      model,
      memoryScope,
      memoryWriteEnabled,
      stateDir,
      isHeartbeat,
    });
  },
  ensureWorkspaceBootstrapFiles,
  loadWorkspaceBootstrapFiles,
  isWorkspaceWritable: async (workspaceDir) => {
    try {
      await access(workspaceDir, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  loadCompactionEntry: async ({ sessionKey, stateDir }) => {
    const store = await resolveCompactionStore(stateDir);
    return store.get(sessionKey);
  },
  saveCompactionEntry: async ({ sessionKey, stateDir, entry }) => {
    const store = await resolveCompactionStore(stateDir);
    await store.upsert(sessionKey, entry);
  },
  cwd: () => process.cwd(),
};

let runtimeOverride: Partial<AgentRunnerRuntime> | null = null;
const reusableSessionBySessionId = new Map<string, PiAgentSessionLike>();

function getRuntime(): AgentRunnerRuntime {
  return {
    ...defaultRuntime,
    ...(runtimeOverride ?? {}),
  };
}

async function resolveAgentSession(params: {
  runtime: AgentRunnerRuntime;
  options: AgentRunOptions;
  cwd: string;
  memoryScope: "main" | "spoke";
  stateDir: string | undefined;
}): Promise<{ session: PiAgentSessionLike; reusable: boolean }> {
  const sessionId = params.options.sessionId?.trim();
  if (typeof sessionId === "string" && sessionId.length > 0) {
    const cached = reusableSessionBySessionId.get(sessionId);
    if (cached !== undefined) {
      return { session: cached, reusable: true };
    }
  }

  const created = await params.runtime.createSession({
    cwd: params.cwd,
    model: process.env.ADJUTANT_MODEL,
    memoryScope: params.memoryScope,
    memoryWriteEnabled: params.options.memoryWriteEnabled,
    stateDir: params.stateDir,
    isHeartbeat: params.options.isHeartbeat === true,
  });

  if (typeof sessionId === "string" && sessionId.length > 0) {
    reusableSessionBySessionId.set(sessionId, created.session);
    return { session: created.session, reusable: true };
  }
  return { session: created.session, reusable: false };
}

function disposeReusableSessions(): void {
  for (const session of reusableSessionBySessionId.values()) {
    try {
      session.dispose();
    } catch {
      // Best-effort cleanup for test/runtime reset.
    }
  }
  reusableSessionBySessionId.clear();
}

function inferToolKind(name: string): "read" | "edit" | "execute" | "search" {
  const normalized = name.trim().toLowerCase();
  if (normalized === "read") {
    return "read";
  }
  if (normalized === "write" || normalized === "edit") {
    return "edit";
  }
  if (normalized === "find" || normalized === "grep" || normalized === "ls") {
    return "search";
  }
  return "execute";
}

function toErrorText(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (value instanceof Error && value.message.length > 0) {
    return value.message;
  }
  return undefined;
}

function extractFinalText(session: PiAgentSessionLike, fallback: string): string {
  const messages = session.state?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return fallback;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null) {
      continue;
    }
    const role = (message as Record<string, unknown>).role;
    if (role !== "assistant") {
      continue;
    }
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }
    const text = content
      .map((entry) => {
        if (typeof entry !== "object" || entry === null) {
          return "";
        }
        const asRecord = entry as Record<string, unknown>;
        return asRecord.type === "text" && typeof asRecord.text === "string" ? asRecord.text : "";
      })
      .join("");
    if (text.length > 0) {
      return text;
    }
  }

  return fallback;
}

function resolveMemoryScope(options: AgentRunOptions): "main" | "spoke" {
  if (options.memoryScope === "main" || options.memoryScope === "spoke") {
    return options.memoryScope;
  }
  return options.sessionKey === "main" ? "main" : "spoke";
}

function shouldInjectBootstrapContext(
  options: AgentRunOptions,
  memoryScope: "main" | "spoke"
): boolean {
  if ((options.origin ?? "system") !== "user") {
    return false;
  }
  if (options.isHeartbeat === true) {
    return false;
  }
  if (options.sessionKey !== "main") {
    return false;
  }
  return memoryScope === "main";
}

function withSystemPrompt(prompt: string, systemPrompt: string): string {
  const userPrompt = prompt.trim();
  const sysPrompt = systemPrompt.trim();
  if (sysPrompt.length === 0) {
    return userPrompt;
  }
  if (userPrompt.length === 0) {
    return sysPrompt;
  }
  return `${sysPrompt}\n\n${userPrompt}`;
}

function maybeBuildPromptWithBootstrap(
  basePrompt: string,
  bootstrapFiles: WorkspaceBootstrapFile[] | undefined
): string {
  if (!bootstrapFiles) {
    return basePrompt;
  }
  const context = renderProjectContext(buildBootstrapContextFiles(bootstrapFiles)).trim();
  if (context.length === 0) {
    return basePrompt;
  }
  return `${context}\n\n${basePrompt}`;
}

function isContextOverflowError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("context overflow") ||
    message.includes("context window") ||
    message.includes("maximum context") ||
    message.includes("too many tokens")
  );
}

function resolveMockDelayMs(value: string | undefined): number {
  if (typeof value !== "string") {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.min(parsed, 30_000);
}

async function waitForAbortableDelay(
  delayMs: number,
  signal: AbortSignal | undefined
): Promise<void> {
  if (delayMs <= 0) {
    return;
  }
  if (signal?.aborted === true) {
    throw new Error("aborted");
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      cleanup();
      reject(new Error("aborted"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  if (options.signal?.aborted === true) {
    throw new Error("aborted");
  }

  if (process.env.ADJUTANT_TEST_MOCK_RUNNER === "1") {
    const delta = process.env.ADJUTANT_TEST_MOCK_DELTA ?? "mock-delta";
    const text = process.env.ADJUTANT_TEST_MOCK_TEXT ?? "mock-final";
    const stopReason = process.env.ADJUTANT_TEST_MOCK_STOP_REASON ?? "end_turn";
    const delayMs = resolveMockDelayMs(process.env.ADJUTANT_TEST_MOCK_DELAY_MS);
    if (delta.length > 0) {
      options.callbacks?.onTextDelta?.(delta);
    }
    await waitForAbortableDelay(delayMs, options.signal);
    return {
      runId: options.runId,
      text,
      stopReason,
    };
  }

  const runtime = getRuntime();
  if (!runtime.isExternalRunnerEnabled()) {
    if (process.env.ADJUTANT_TEST_FAKE_TOOL_CALLS === "1") {
      options.callbacks?.onToolCall?.({
        event: "tool_execution_start",
        toolCallId: "fake_call_1",
        name: "fake_tool",
        title: "fake_tool",
        kind: "execute",
        rawInput: { prompt: options.prompt },
      });
    }

    options.callbacks?.onTextDelta?.(options.prompt);

    if (process.env.ADJUTANT_TEST_FAKE_TOOL_CALLS === "1") {
      options.callbacks?.onToolCall?.({
        event: "tool_execution_end",
        toolCallId: "fake_call_1",
        name: "fake_tool",
        status: "ok",
        rawOutput: { ok: true },
      });
    }

    return {
      runId: options.runId,
      text: options.prompt,
      stopReason: "end_turn",
    };
  }

  const cwd = runtime.cwd();
  const memoryScope = resolveMemoryScope(options);
  const stateDir = process.env.ADJUTANT_STATE_DIR;

  let bootstrapFiles: WorkspaceBootstrapFile[] | undefined;
  if (shouldInjectBootstrapContext(options, memoryScope)) {
    await runtime.ensureWorkspaceBootstrapFiles(cwd);
    bootstrapFiles = await runtime.loadWorkspaceBootstrapFiles(cwd);
  }

  const preparedPrompt = maybeBuildPromptWithBootstrap(options.prompt, bootstrapFiles);

  const { session, reusable } = await resolveAgentSession({
    runtime,
    options,
    cwd,
    memoryScope,
    stateDir,
  });

  const compactionSettings = resolveCompactionRuntimeSettings();
  const compactionEntry = await runtime.loadCompactionEntry({
    sessionKey: options.sessionKey,
    stateDir,
  });
  const compactionMetadata = resolveSessionCompactionMetadata(
    compactionEntry as unknown as Record<string, unknown> | undefined
  );
  const compactionTracker = createCompactionEventTracker(compactionMetadata.compactionCount);

  let textBuffer = "";
  let silentTurn = false;
  const unsubscribe = session.subscribe((event) => {
    if (typeof event !== "object" || event === null) {
      return;
    }

    const record = event as Record<string, unknown>;
    compactionTracker.onEvent(record);

    if (silentTurn) {
      return;
    }

    if (record.type === "message_update") {
      const messageEvent = record.assistantMessageEvent;
      if (
        typeof messageEvent === "object" &&
        messageEvent !== null &&
        (messageEvent as Record<string, unknown>).type === "text_delta"
      ) {
        const delta = (messageEvent as Record<string, unknown>).delta;
        if (typeof delta === "string" && delta.length > 0) {
          textBuffer += delta;
          options.callbacks?.onTextDelta?.(delta);
        }
      }
      if (
        typeof messageEvent === "object" &&
        messageEvent !== null &&
        (messageEvent as Record<string, unknown>).type === "thinking_delta"
      ) {
        const delta = (messageEvent as Record<string, unknown>).delta;
        if (typeof delta === "string" && delta.length > 0) {
          options.callbacks?.onThinkingDelta?.(delta);
        }
      }
      return;
    }

    if (record.type === "tool_execution_start") {
      const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
      options.callbacks?.onToolCall?.({
        event: "tool_execution_start",
        toolCallId: typeof record.toolCallId === "string" ? record.toolCallId : undefined,
        name: toolName,
        title: toolName,
        kind: inferToolKind(toolName),
        rawInput: record.args,
      });
      return;
    }

    if (record.type === "tool_execution_end") {
      const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
      const isError = record.isError === true;
      options.callbacks?.onToolCall?.({
        event: "tool_execution_end",
        toolCallId: typeof record.toolCallId === "string" ? record.toolCallId : undefined,
        name: toolName,
        status: isError ? "error" : "ok",
        rawOutput: record.result,
        error: isError ? toErrorText(record.result) : undefined,
      });
    }
  });

  const abortHandler = () => {
    void session.abort?.();
  };
  options.signal?.addEventListener("abort", abortHandler);

  let memoryFlushMetadata:
    | {
        executedAtIso: string;
        compactionCountAtFlush: number;
      }
    | undefined;

  try {
    compactionTracker.setContextUsage(session.getContextUsage?.());
    const workspaceWritable = await runtime.isWorkspaceWritable(cwd);
    const flushDecision = shouldRunPreCompactionMemoryFlush({
      settings: compactionSettings.memoryFlush,
      metadata: compactionMetadata,
      contextUsage: session.getContextUsage?.(),
      isMainSession: memoryScope === "main",
      isHeartbeat: options.isHeartbeat === true,
      workspaceWritable,
    });

    if (flushDecision.shouldRun) {
      silentTurn = true;
      try {
        await session.prompt(
          withSystemPrompt(
            compactionSettings.memoryFlush.prompt,
            compactionSettings.memoryFlush.systemPrompt
          )
        );
        compactionTracker.markFlushTriggered();
        memoryFlushMetadata = {
          executedAtIso: new Date().toISOString(),
          compactionCountAtFlush: compactionTracker.getCompactionCount(),
        };
      } catch (error) {
        console.warn("[AgentRunner][MemoryFlush] flush turn failed", {
          runId: options.runId,
          sessionKey: options.sessionKey,
          toolCallId: null,
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        silentTurn = false;
      }
      compactionTracker.setContextUsage(session.getContextUsage?.());
    }

    let attempts = 0;
    for (;;) {
      try {
        await session.prompt(preparedPrompt);
        break;
      } catch (error) {
        if (isContextOverflowError(error) && attempts < 1) {
          attempts += 1;
          if (compactionSettings.compactionEnabled && typeof session.compact === "function") {
            await session.compact();
            compactionTracker.markCompactionCompleted("overflow");
            continue;
          }
        }
        throw error;
      }
    }

    const text = extractFinalText(session, textBuffer);
    options.callbacks?.onTerminalRecord?.({
      runId: options.runId,
      sessionKey: options.sessionKey,
      actionType: "assistant_final",
      status: "recorded",
      ts: new Date().toISOString(),
    });
    return {
      runId: options.runId,
      text,
      stopReason: "end_turn",
    };
  } catch (error) {
    if (options.signal?.aborted) {
      options.callbacks?.onTerminalRecord?.({
        runId: options.runId,
        sessionKey: options.sessionKey,
        actionType: "assistant_aborted",
        status: "recorded",
        ts: new Date().toISOString(),
      });
      throw new Error("aborted");
    }

    options.callbacks?.onTerminalRecord?.({
      runId: options.runId,
      sessionKey: options.sessionKey,
      actionType: "assistant_error",
      status: "recorded",
      ts: new Date().toISOString(),
    });
    throw error;
  } finally {
    compactionTracker.setContextUsage(session.getContextUsage?.());
    const contextSnapshot = compactionTracker.getContextSnapshot();
    try {
      await runtime.saveCompactionEntry({
        sessionKey: options.sessionKey,
        stateDir,
        entry: {
          compactionCount: compactionTracker.getCompactionCount(),
          memoryFlushCompactionCount:
            memoryFlushMetadata?.compactionCountAtFlush ??
            compactionEntry?.memoryFlushCompactionCount ??
            null,
          memoryFlushAt: memoryFlushMetadata?.executedAtIso ?? compactionEntry?.memoryFlushAt,
          contextTokens: contextSnapshot.contextTokens,
          contextWindowTokens: contextSnapshot.contextWindowTokens,
        },
      });
    } catch (error) {
      console.warn("[AgentRunner] failed to persist compaction session entry", {
        runId: options.runId,
        sessionKey: options.sessionKey,
        toolCallId: null,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    options.signal?.removeEventListener("abort", abortHandler);
    unsubscribe();
    if (!reusable) {
      session.dispose();
    }
  }
}

export function setAgentRunnerRuntimeForTest(runtime: Partial<AgentRunnerRuntime> | null): void {
  disposeReusableSessions();
  runtimeOverride = runtime;
}
