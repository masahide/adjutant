import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { buildEventContext } from "./context-builder.js";
import { readEvents } from "./event-reader.js";
import { runAgent, type AgentRunOptions, type AgentRunResult } from "./agent-runner.js";
import { getQueueSize } from "./command-queue.js";
import { readMemoryFiles } from "./memory-reader.js";
import { normalizeSessionKey, normalizeTimezone } from "./shared-normalizers.js";
import {
  readSessionEntryStore,
  writeSessionEntryStore,
  getSessionEntry,
  upsertSessionEntry,
  parseIsoMs,
  type SessionEntryStore,
} from "./session-entry-store.js";
import type { HeartbeatEventPayload, HeartbeatRunRecord, HeartbeatRunResult } from "./types.js";

export type HeartbeatConfig = {
  intervalMs?: number;
  timeoutMs?: number;
  sessionKey?: string;
  heartbeatFilePath?: string;
  soulFilePath?: string;
  userFilePath?: string;
  agentsFilePath?: string;
  dataDir: string;
  workspaceDir?: string;
  userTimezone?: string;
  retryDelayMs?: number;
  ackMaxChars?: number;
  model?: string;
  activeHours?: {
    start: string;
    end: string;
    timezone?: string;
  };
  sessionEntriesPath?: string;
  channelsVisibility?: {
    showOk?: boolean;
    showAlerts?: boolean;
    useIndicator?: boolean;
  };
  channelsConfigPath?: string;
  readinessCheck?: (kind: "ok" | "alert") => boolean;
};

type ActiveHoursConfig = NonNullable<HeartbeatConfig["activeHours"]>;
type UnknownRecord = Record<string, unknown>;
type IntervalTimer = ReturnType<typeof setInterval>;
type TimeoutTimer = ReturnType<typeof setTimeout>;
type HeartbeatAgentResult = Pick<AgentRunResult, "text" | "modelId">;

type HeartbeatRuntime = {
  now: () => Date;
  readTextFile: (path: string) => Promise<string>;
  readEvents: typeof readEvents;
  readMemoryFiles: typeof readMemoryFiles;
  buildEventContext: typeof buildEventContext;
  getQueueSize: typeof getQueueSize;
  runAgent: (opts: AgentRunOptions) => Promise<HeartbeatAgentResult>;
  appendRunRecord: (dataDir: string, record: HeartbeatRunRecord) => Promise<void>;
  loadSessionEntryStore: (
    customPath?: string
  ) => Promise<{ path: string; store: SessionEntryStore }>;
  saveSessionEntryStore: (store: SessionEntryStore, customPath?: string) => Promise<string>;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

type HeartbeatVisibility = {
  showOk: boolean;
  showAlerts: boolean;
  useIndicator: boolean;
};

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_ACK_MAX_CHARS = 300;
const DEFAULT_HEARTBEAT_PROMPT = "# HEARTBEAT\n\nHEARTBEAT_OK の場合はそれだけを返してください。";
const HEARTBEAT_RUN_RECORD_RELATIVE_PATH = join("_assistant", "heartbeat-runs.jsonl");
const HEARTBEAT_DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const SESSION_KEY_PATTERN = /^[A-Za-z0-9:_-]+$/;

const listeners = new Set<(evt: HeartbeatEventPayload) => void>();
let lastHeartbeatEvent: HeartbeatEventPayload | null = null;
let runtimeOverride: Partial<HeartbeatRuntime> | null = null;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) {
    return cached;
  }
  const created = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  formatterCache.set(timezone, created);
  return created;
}

async function appendRunRecordDefault(dataDir: string, record: HeartbeatRunRecord): Promise<void> {
  const recordPath = join(dataDir, HEARTBEAT_RUN_RECORD_RELATIVE_PATH);
  await mkdir(dirname(recordPath), { recursive: true });
  await appendFile(recordPath, `${JSON.stringify(record)}\n`, "utf8");
}

const defaultRuntime: HeartbeatRuntime = {
  now: () => new Date(),
  readTextFile: async (path) => readFile(path, "utf8"),
  readEvents,
  readMemoryFiles,
  buildEventContext,
  getQueueSize,
  runAgent,
  appendRunRecord: appendRunRecordDefault,
  loadSessionEntryStore: readSessionEntryStore,
  saveSessionEntryStore: writeSessionEntryStore,
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
};

function getRuntime(): HeartbeatRuntime {
  return {
    ...defaultRuntime,
    ...(runtimeOverride ?? {}),
  };
}

function emitHeartbeatEvent(payload: HeartbeatEventPayload): void {
  lastHeartbeatEvent = payload;
  for (const listener of listeners) {
    listener(payload);
  }
}

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as UnknownRecord;
}

function resolveTimezone(config: HeartbeatConfig): string {
  return normalizeTimezone(config.userTimezone);
}

function resolveWorkspaceDir(config: HeartbeatConfig): string {
  const configured = config.workspaceDir?.trim();
  return configured || process.cwd();
}

function resolvePath(filePath: string): string {
  if (isAbsolute(filePath)) {
    return filePath;
  }
  return join(process.cwd(), filePath);
}

function resolveSessionKeyWithFallback(
  store: SessionEntryStore,
  requestedSessionKey: string
): string {
  if (requestedSessionKey === "main") {
    return "main";
  }
  if (!SESSION_KEY_PATTERN.test(requestedSessionKey)) {
    return "main";
  }

  const entry = getSessionEntry(store, requestedSessionKey);
  if (!entry) {
    return "main";
  }

  const hasSessionId = typeof entry.sessionId === "string" && entry.sessionId.trim().length > 0;
  if (!hasSessionId) {
    return "main";
  }

  const agent = typeof entry.agent === "string" ? entry.agent.trim().toLowerCase() : "";
  if (agent && agent !== "adjutant" && agent !== "assistant") {
    return "main";
  }

  return requestedSessionKey;
}

function resolveIntervalMs(config: HeartbeatConfig): number {
  if (!Number.isFinite(config.intervalMs)) {
    return DEFAULT_INTERVAL_MS;
  }
  return Math.max(1, Math.floor(config.intervalMs as number));
}

function resolveRetryDelayMs(config: HeartbeatConfig): number {
  if (!Number.isFinite(config.retryDelayMs)) {
    return DEFAULT_RETRY_DELAY_MS;
  }
  return Math.max(1, Math.floor(config.retryDelayMs as number));
}

function resolveTimeoutMs(config: HeartbeatConfig): number {
  if (!Number.isFinite(config.timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1, Math.floor(config.timeoutMs as number));
}

function resolveAckMaxChars(config: HeartbeatConfig): number {
  if (!Number.isFinite(config.ackMaxChars)) {
    return DEFAULT_ACK_MAX_CHARS;
  }
  return Math.max(0, Math.floor(config.ackMaxChars as number));
}

function isErrno(error: unknown, code: string): boolean {
  const record = asRecord(error);
  return record?.code === code;
}

async function readOptionalText(runtime: HeartbeatRuntime, path: string): Promise<string | null> {
  try {
    return await runtime.readTextFile(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function stripMarkdownDecorators(text: string): string {
  const noLinks = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  const noInlineCode = noLinks.replace(/`+/g, " ");
  const noEmphasis = noInlineCode.replace(/[*_~]/g, " ");
  const noBlockquote = noEmphasis.replace(/^[>\-#\s]+/gm, "");
  return noBlockquote;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function stripHeartbeatToken(
  value: string,
  ackMaxChars: number
): { normalizedText: string; hasOkToken: boolean; shouldSkip: boolean } {
  const hasOkToken = /\bHEARTBEAT_OK\b/i.test(value);
  const withoutHtml = value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ");
  const withoutToken = withoutHtml.replace(/\bHEARTBEAT_OK\b/gi, " ");
  const normalizedText = collapseWhitespace(stripMarkdownDecorators(withoutToken));
  const shouldSkip = hasOkToken || normalizedText.length <= Math.max(0, ackMaxChars);
  return {
    normalizedText,
    hasOkToken,
    shouldSkip,
  };
}

function isEffectivelyEmptyHeartbeatPrompt(text: string): boolean {
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, " ");
  return collapseWhitespace(withoutComments).length === 0;
}

function formatCurrentTimeLine(now: Date, timezone: string): string {
  try {
    const formatted = getFormatter(timezone).format(now);
    return `Current time: ${formatted} (${timezone})`;
  } catch {
    return `Current time: ${now.toISOString()} (${timezone})`;
  }
}

function injectCurrentTimeLine(text: string, now: Date, timezone: string): string {
  if (/^\s*Current time:/im.test(text)) {
    return text;
  }
  const line = formatCurrentTimeLine(now, timezone);
  const trimmed = text.trim();
  if (!trimmed) {
    return line;
  }
  return `${trimmed}\n\n${line}`;
}

function parseHHMM(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const hour = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }
  if (hour === 24 && minute === 0) {
    return 24 * 60;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

function resolveTimeZoneForActiveHours(
  config: HeartbeatConfig,
  activeHours: ActiveHoursConfig
): string {
  const tz = activeHours.timezone?.trim();
  if (!tz || tz === "user") {
    return resolveTimezone(config);
  }
  if (tz === "local") {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || resolveTimezone(config);
  }
  return tz;
}

function getMinutesInTimezone(now: Date, timezone: string): number | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const hour = Number.parseInt(parts.find((part) => part.type === "hour")?.value ?? "", 10);
    const minute = Number.parseInt(parts.find((part) => part.type === "minute")?.value ?? "", 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

function isWithinActiveHours(config: HeartbeatConfig, now: Date): boolean {
  if (!config.activeHours) {
    return true;
  }
  const activeHours = config.activeHours;
  const start = parseHHMM(activeHours.start);
  const end = parseHHMM(activeHours.end);
  if (start === null || end === null) {
    return true;
  }

  const timezone = resolveTimeZoneForActiveHours(config, activeHours);
  const minuteOfDay = getMinutesInTimezone(now, timezone);
  if (minuteOfDay === null) {
    return true;
  }

  if (start === end) {
    return true;
  }
  if (start < end) {
    return minuteOfDay >= start && minuteOfDay < end;
  }
  return minuteOfDay >= start || minuteOfDay < end;
}

function computeContentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function toReason(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "heartbeat-runner-error";
}

function buildRunRecord(params: {
  runAt: Date;
  sessionKey: string;
  result: HeartbeatRunResult;
  triggerReason?: string;
  modelId?: string;
  preview?: string;
}): HeartbeatRunRecord {
  return {
    schema: "adjutant.heartbeat.result.v1",
    runAt: params.runAt.toISOString(),
    sessionKey: params.sessionKey,
    result: params.result,
    triggerReason: params.triggerReason,
    modelId: params.modelId,
    preview: params.preview,
  };
}

async function persistRunRecord(
  runtime: HeartbeatRuntime,
  dataDir: string,
  record: HeartbeatRunRecord
) {
  try {
    await runtime.appendRunRecord(dataDir, record);
  } catch (error) {
    console.warn("[HeartbeatRunner] failed to append run record:", error);
  }
}

type FinalizeRunOptions = {
  runtime: HeartbeatRuntime;
  dataDir: string;
  runAt: Date;
  sessionKey: string;
  triggerReason?: string;
  result: HeartbeatRunResult;
  event: Omit<HeartbeatEventPayload, "ts"> & { ts?: number };
  record?: {
    modelId?: string;
    preview?: string;
  };
};

async function finalizeRun(options: FinalizeRunOptions): Promise<HeartbeatRunResult> {
  emitHeartbeatEvent({
    ts: options.event.ts ?? options.runtime.now().getTime(),
    ...options.event,
  });
  await persistRunRecord(
    options.runtime,
    options.dataDir,
    buildRunRecord({
      runAt: options.runAt,
      sessionKey: options.sessionKey,
      result: options.result,
      triggerReason: options.triggerReason,
      modelId: options.record?.modelId,
      preview: options.record?.preview,
    })
  );
  return options.result;
}

async function resolvePrecheckSkip(params: {
  runtime: HeartbeatRuntime;
  config: HeartbeatConfig;
  runAt: Date;
  sessionKey: string;
  triggerReason?: string;
}): Promise<HeartbeatRunResult | null> {
  if (!isWithinActiveHours(params.config, params.runAt)) {
    const result: HeartbeatRunResult = { status: "skipped", reason: "quiet-hours" };
    return await finalizeRun({
      runtime: params.runtime,
      dataDir: params.config.dataDir,
      runAt: params.runAt,
      sessionKey: params.sessionKey,
      triggerReason: params.triggerReason,
      result,
      event: {
        ts: params.runAt.getTime(),
        status: "skipped",
        reason: result.reason,
        indicatorType: "ok",
      },
    });
  }

  const visibility = await resolveVisibility(params.runtime, params.config);
  if (isVisibilityDisabled(visibility)) {
    const result: HeartbeatRunResult = { status: "skipped", reason: "alerts-disabled" };
    return await finalizeRun({
      runtime: params.runtime,
      dataDir: params.config.dataDir,
      runAt: params.runAt,
      sessionKey: params.sessionKey,
      triggerReason: params.triggerReason,
      result,
      event: {
        ts: params.runAt.getTime(),
        status: "skipped",
        reason: result.reason,
        indicatorType: "ok",
      },
    });
  }

  if (params.runtime.getQueueSize("main") > 0) {
    const result: HeartbeatRunResult = { status: "skipped", reason: "requests-in-flight" };
    return await finalizeRun({
      runtime: params.runtime,
      dataDir: params.config.dataDir,
      runAt: params.runAt,
      sessionKey: params.sessionKey,
      triggerReason: params.triggerReason,
      result,
      event: {
        ts: params.runAt.getTime(),
        status: "skipped",
        reason: result.reason,
        indicatorType: "ok",
      },
    });
  }

  return null;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no") {
      return false;
    }
  }
  return fallback;
}

function normalizeVisibility(input: unknown): HeartbeatVisibility | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const record = input as UnknownRecord;
  return {
    showOk: toBoolean(record.showOk, true),
    showAlerts: toBoolean(record.showAlerts, true),
    useIndicator: toBoolean(record.useIndicator, true),
  };
}

async function resolveVisibility(
  runtime: HeartbeatRuntime,
  config: HeartbeatConfig
): Promise<HeartbeatVisibility> {
  const fromConfig = normalizeVisibility(config.channelsVisibility);
  if (fromConfig) {
    return fromConfig;
  }

  const channelsConfigPath =
    config.channelsConfigPath?.trim() || process.env.ADJUTANT_CHANNELS_CONFIG_PATH?.trim();
  if (!channelsConfigPath) {
    return { showOk: true, showAlerts: true, useIndicator: true };
  }

  const raw = await readOptionalText(runtime, resolvePath(channelsConfigPath));
  if (!raw) {
    return { showOk: true, showAlerts: true, useIndicator: true };
  }

  try {
    const parsed = JSON.parse(raw) as UnknownRecord;
    const candidates = [
      parsed.heartbeat,
      (parsed.defaults as UnknownRecord | undefined)?.heartbeat,
      (parsed.channels as UnknownRecord | undefined)?.defaults,
      ((parsed.channels as UnknownRecord | undefined)?.defaults as UnknownRecord | undefined)
        ?.heartbeat,
    ];
    for (const candidate of candidates) {
      const visibility = normalizeVisibility(candidate);
      if (visibility) {
        return visibility;
      }
    }
  } catch {
    // ignore malformed config
  }

  return { showOk: true, showAlerts: true, useIndicator: true };
}

function isVisibilityDisabled(visibility: HeartbeatVisibility): boolean {
  return !visibility.showOk && !visibility.showAlerts && !visibility.useIndicator;
}

function isReadinessOk(config: HeartbeatConfig, kind: "ok" | "alert"): boolean {
  if (!config.readinessCheck) {
    return true;
  }
  try {
    return config.readinessCheck(kind);
  } catch {
    return false;
  }
}

function isDuplicateAlert(entry: UnknownRecord, normalizedAlert: string, nowMs: number): boolean {
  const lastText = typeof entry.lastHeartbeatText === "string" ? entry.lastHeartbeatText : "";
  const lastSentAt = parseIsoMs(entry.lastHeartbeatSentAt);
  if (!lastText || lastSentAt === null) {
    return false;
  }
  if (lastText !== normalizedAlert) {
    return false;
  }
  return nowMs - lastSentAt < HEARTBEAT_DUPLICATE_WINDOW_MS;
}

async function rememberHeartbeatAlert(params: {
  runtime: HeartbeatRuntime;
  store: SessionEntryStore;
  sessionKey: string;
  normalizedAlert: string;
  now: Date;
  sessionEntriesPath?: string;
}): Promise<void> {
  const entry = upsertSessionEntry(params.store, params.sessionKey);
  entry.lastHeartbeatText = params.normalizedAlert;
  entry.lastHeartbeatSentAt = params.now.toISOString();
  await params.runtime.saveSessionEntryStore(params.store, params.sessionEntriesPath);
}

async function runWithTimeout<T>(
  runtime: HeartbeatRuntime,
  timeoutMs: number,
  task: () => Promise<T>
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = runtime.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`heartbeat timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    task()
      .then((value) => {
        if (settled) {
          return;
        }
        settled = true;
        runtime.clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) {
          return;
        }
        settled = true;
        runtime.clearTimeout(timer);
        reject(error);
      });
  });
}

export async function runOnce(
  config: HeartbeatConfig,
  opts?: { reason?: string }
): Promise<HeartbeatRunResult> {
  const runtime = getRuntime();
  const runAt = runtime.now();
  const startedAtMs = runAt.getTime();
  const timezone = resolveTimezone(config);
  const ackMaxChars = resolveAckMaxChars(config);
  const timeoutMs = resolveTimeoutMs(config);

  const { store: sessionStore } = await runtime.loadSessionEntryStore(config.sessionEntriesPath);
  const requestedSessionKey = normalizeSessionKey(config.sessionKey);
  const sessionKey = resolveSessionKeyWithFallback(sessionStore, requestedSessionKey);

  const prechecked = await resolvePrecheckSkip({
    runtime,
    config,
    runAt,
    sessionKey,
    triggerReason: opts?.reason,
  });
  if (prechecked) {
    return prechecked;
  }

  try {
    const heartbeatPath = resolvePath(config.heartbeatFilePath ?? "assistant/prompts/HEARTBEAT.md");
    const heartbeatPromptRaw = await readOptionalText(runtime, heartbeatPath);
    const heartbeatPrompt = normalizeText(heartbeatPromptRaw ?? DEFAULT_HEARTBEAT_PROMPT);
    if (isEffectivelyEmptyHeartbeatPrompt(heartbeatPrompt)) {
      const result: HeartbeatRunResult = { status: "skipped", reason: "empty-heartbeat-file" };
      return await finalizeRun({
        runtime,
        dataDir: config.dataDir,
        runAt,
        sessionKey,
        triggerReason: opts?.reason,
        result,
        event: {
          status: "skipped",
          reason: result.reason,
          indicatorType: "ok",
        },
      });
    }

    const workspaceDir = resolveWorkspaceDir(config);
    const [events, memory, soulPromptRaw, userPromptRaw, agentsPromptRaw] = await Promise.all([
      runtime.readEvents({
        dataDir: config.dataDir,
      }),
      runtime.readMemoryFiles({
        workspaceDir,
        timezone,
      }),
      readOptionalText(runtime, resolvePath(config.soulFilePath ?? "assistant/prompts/SOUL.md")),
      readOptionalText(runtime, resolvePath(config.userFilePath ?? "assistant/prompts/USER.md")),
      readOptionalText(
        runtime,
        resolvePath(config.agentsFilePath ?? "assistant/prompts/AGENTS.md")
      ),
    ]);

    const context = runtime.buildEventContext({
      events,
      memoryContent: memory.longTerm ?? undefined,
      dailyMemoryContent: memory.daily ?? undefined,
      yesterdayMemoryContent: memory.yesterday ?? undefined,
    });

    const systemPrompt = [soulPromptRaw, userPromptRaw, agentsPromptRaw]
      .map((part) => (typeof part === "string" ? part.trim() : ""))
      .filter(Boolean)
      .join("\n\n");
    const body = injectCurrentTimeLine(
      [heartbeatPrompt, context.text]
        .map((v) => v.trim())
        .filter(Boolean)
        .join("\n\n"),
      runAt,
      timezone
    );

    const agentResult = await runWithTimeout(runtime, timeoutMs, async () => {
      return await runtime.runAgent({
        runId: `hb-${runAt.getTime()}`,
        prompt: body,
        systemPrompt,
        sessionKey,
        isHeartbeat: true,
        model: config.model,
        workspaceDir,
        timezone,
        sessionEntriesPath: config.sessionEntriesPath,
      });
    });

    const durationMs = Math.max(0, runtime.now().getTime() - startedAtMs);
    const stripped = stripHeartbeatToken(agentResult.text, ackMaxChars);
    if (stripped.shouldSkip) {
      const eventStatus: HeartbeatEventPayload["status"] = stripped.hasOkToken
        ? "ok-token"
        : "ok-empty";
      const result: HeartbeatRunResult = {
        status: "ran",
        durationMs,
        contentHash: computeContentHash(agentResult.text),
        modelId: agentResult.modelId ?? config.model,
      };

      const readinessOk = isReadinessOk(config, "ok");
      return await finalizeRun({
        runtime,
        dataDir: config.dataDir,
        runAt,
        sessionKey,
        triggerReason: opts?.reason,
        result,
        event: {
          status: eventStatus,
          durationMs,
          reason: readinessOk ? undefined : "readiness-failed",
          indicatorType: "ok",
          preview: stripped.normalizedText.slice(0, 240),
        },
        record: {
          modelId: result.modelId,
          preview: stripped.normalizedText.slice(0, 240),
        },
      });
    }

    const alertText = stripped.normalizedText || agentResult.text.trim();
    const readinessOk = isReadinessOk(config, "alert");
    if (!readinessOk) {
      const result: HeartbeatRunResult = { status: "skipped", reason: "readiness-failed" };
      return await finalizeRun({
        runtime,
        dataDir: config.dataDir,
        runAt,
        sessionKey,
        triggerReason: opts?.reason,
        result,
        event: {
          status: "skipped",
          reason: result.reason,
          indicatorType: "error",
        },
      });
    }

    const sessionEntry = getSessionEntry(sessionStore, sessionKey) ?? {};
    if (isDuplicateAlert(sessionEntry, alertText, runAt.getTime())) {
      const result: HeartbeatRunResult = {
        status: "ran",
        durationMs,
        contentHash: computeContentHash(alertText),
        modelId: agentResult.modelId ?? config.model,
      };
      return await finalizeRun({
        runtime,
        dataDir: config.dataDir,
        runAt,
        sessionKey,
        triggerReason: opts?.reason,
        result,
        event: {
          status: "skipped",
          reason: "duplicate",
          durationMs,
          preview: alertText.slice(0, 240),
          indicatorType: "ok",
        },
        record: {
          modelId: result.modelId,
          preview: alertText.slice(0, 240),
        },
      });
    }

    const result: HeartbeatRunResult = {
      status: "ran",
      durationMs,
      alert: alertText,
      contentHash: computeContentHash(alertText),
      modelId: agentResult.modelId ?? config.model,
    };

    await rememberHeartbeatAlert({
      runtime,
      store: sessionStore,
      sessionKey,
      normalizedAlert: alertText,
      now: runAt,
      sessionEntriesPath: config.sessionEntriesPath,
    });

    return await finalizeRun({
      runtime,
      dataDir: config.dataDir,
      runAt,
      sessionKey,
      triggerReason: opts?.reason,
      result,
      event: {
        status: "sent",
        durationMs,
        preview: alertText.slice(0, 240),
        indicatorType: "alert",
      },
      record: {
        modelId: result.modelId,
        preview: alertText.slice(0, 240),
      },
    });
  } catch (error) {
    const reason = toReason(error);
    const result: HeartbeatRunResult = { status: "failed", reason };
    return await finalizeRun({
      runtime,
      dataDir: config.dataDir,
      runAt,
      sessionKey,
      triggerReason: opts?.reason,
      result,
      event: {
        status: "failed",
        reason,
        indicatorType: "error",
      },
    });
  }
}

export function startHeartbeat(config: HeartbeatConfig): { stop: () => void } {
  const runtime = getRuntime();
  const intervalMs = resolveIntervalMs(config);
  const retryDelayMs = resolveRetryDelayMs(config);

  let stopped = false;
  let running = false;
  let intervalTimer: IntervalTimer | null = null;
  let retryTimer: TimeoutTimer | null = null;

  const scheduleRetry = () => {
    if (stopped || retryTimer) {
      return;
    }
    retryTimer = runtime.setTimeout(() => {
      retryTimer = null;
      void executeTick("requests-in-flight-retry");
    }, retryDelayMs);
  };

  const executeTick = async (reason: string) => {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      const result = await runOnce(config, { reason });
      if (result.status === "skipped" && result.reason === "requests-in-flight") {
        scheduleRetry();
      }
    } finally {
      running = false;
    }
  };

  intervalTimer = runtime.setInterval(() => {
    void executeTick("timer");
  }, intervalMs);

  return {
    stop: () => {
      stopped = true;
      if (intervalTimer) {
        runtime.clearInterval(intervalTimer);
        intervalTimer = null;
      }
      if (retryTimer) {
        runtime.clearTimeout(retryTimer);
        retryTimer = null;
      }
    },
  };
}

export function onHeartbeatEvent(listener: (evt: HeartbeatEventPayload) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLastHeartbeatEvent(): HeartbeatEventPayload | null {
  if (!lastHeartbeatEvent) {
    return null;
  }
  return { ...lastHeartbeatEvent };
}

export function setHeartbeatRuntimeForTest(runtime: Partial<HeartbeatRuntime> | null): void {
  runtimeOverride = runtime;
}

export function resetHeartbeatRunnerForTest(): void {
  runtimeOverride = null;
  listeners.clear();
  lastHeartbeatEvent = null;
}
