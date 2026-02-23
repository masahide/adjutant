import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveAdjutantStateDir } from "./session-paths.js";

export type AuditOrigin = "user" | "pipeline" | "system";

export type AuditToolSummary = {
  toolName: string;
  toolCallId?: string;
  args?: unknown;
  resultSummary?: unknown;
  status?: "ok" | "error";
  durationMs?: number;
  truncated?: boolean;
  error?: string;
  startedAt?: string;
  endedAt?: string;
};

export type RunAuditResponse = {
  runId: string;
  origin?: AuditOrigin;
  runEnded: boolean;
  tools: AuditToolSummary[];
};

export type AuditRunMetadata = {
  toolEndCountByRunId: Map<string, number>;
  messageRunIdByMessageId: Map<string, string>;
};

type AuditToolEvent = {
  type: "tool.start" | "tool.end";
  runId: string;
  toolName: string;
  toolCallId?: string;
  args?: unknown;
  resultSummary?: unknown;
  status?: "ok" | "error";
  durationMs?: number;
  truncated?: boolean;
  error?: string;
  ts?: string;
};

type AuditRunStartEvent = {
  type: "run.start";
  runId: string;
  origin?: AuditOrigin;
};

type AuditRunEndEvent = {
  type: "run.end";
  runId: string;
};

type AuditMessageBindEvent = {
  type: "message.bind";
  runId: string;
  messageId: string;
  role?: "user" | "assistant";
};

type ParsedAuditEvent =
  | AuditRunStartEvent
  | AuditRunEndEvent
  | AuditToolEvent
  | AuditMessageBindEvent;

type CachedRunAuditEntry = {
  expiresAt: number;
  value: RunAuditResponse;
};

const RUN_CACHE_MAX_ENTRIES = 32;
const RUN_CACHE_TTL_MS = 60_000;
const AGENT_AUDIT_DEFAULT_RELATIVE_PATH = join("audit", "agent-audit.ndjson");

const runAuditCache = new Map<string, CachedRunAuditEntry>();

let nowMsFn: () => number = () => Date.now();

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function takeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function takeOrigin(value: unknown): AuditOrigin | undefined {
  if (value === "user" || value === "pipeline" || value === "system") {
    return value;
  }
  return undefined;
}

function takeStatus(value: unknown): "ok" | "error" | undefined {
  if (value === "ok" || value === "error") {
    return value;
  }
  return undefined;
}

function takeFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function warnInvalidLine(reason: string, lineNo: number): void {
  console.warn("[AuditReader] invalid audit line skipped", { reason, lineNo });
}

function parseAuditLine(rawLine: string, lineNo: number): ParsedAuditEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    warnInvalidLine("json-parse-failed", lineNo);
    return null;
  }

  const record = asRecord(parsed);
  if (!record) {
    warnInvalidLine("not-object", lineNo);
    return null;
  }

  const type = takeString(record.type);
  const runId = takeString(record.runId);
  if (!type || !runId) {
    warnInvalidLine("missing-type-or-run-id", lineNo);
    return null;
  }

  if (type === "run.start") {
    return {
      type,
      runId,
      origin: takeOrigin(record.origin),
    };
  }

  if (type === "run.end") {
    return {
      type,
      runId,
    };
  }

  if (type === "message.bind") {
    const messageId = takeString(record.messageId);
    if (!messageId) {
      warnInvalidLine("missing-message-id", lineNo);
      return null;
    }
    const role = record.role === "user" || record.role === "assistant" ? record.role : undefined;
    return {
      type,
      runId,
      messageId,
      role,
    };
  }

  if (type !== "tool.start" && type !== "tool.end") {
    return null;
  }

  const toolName = takeString(record.toolName);
  if (!toolName) {
    warnInvalidLine("missing-tool-name", lineNo);
    return null;
  }

  return {
    type,
    runId,
    toolName,
    toolCallId: takeString(record.toolCallId),
    args: record.args,
    resultSummary: record.resultSummary,
    status: takeStatus(record.status),
    durationMs: takeFiniteNumber(record.durationMs),
    truncated: typeof record.truncated === "boolean" ? record.truncated : undefined,
    error: takeString(record.error),
    ts: takeString(record.ts),
  };
}

function pushPendingIndex(map: Map<string, number[]>, key: string, index: number): void {
  const bucket = map.get(key);
  if (bucket) {
    bucket.push(index);
    return;
  }
  map.set(key, [index]);
}

function popPendingIndex(map: Map<string, number[]>, key: string): number | null {
  const bucket = map.get(key);
  if (!bucket || bucket.length === 0) {
    return null;
  }
  const index = bucket.pop();
  if (bucket.length === 0) {
    map.delete(key);
  }
  return typeof index === "number" ? index : null;
}

function removePendingIndex(map: Map<string, number[]>, key: string, index: number): void {
  const bucket = map.get(key);
  if (!bucket || bucket.length === 0) {
    return;
  }
  const position = bucket.lastIndexOf(index);
  if (position < 0) {
    return;
  }
  bucket.splice(position, 1);
  if (bucket.length === 0) {
    map.delete(key);
  }
}

function resolveToolMatchIndex(
  event: AuditToolEvent,
  pendingByCallId: Map<string, number[]>,
  pendingByName: Map<string, number[]>
): number | null {
  if (event.toolCallId) {
    const matched = popPendingIndex(pendingByCallId, event.toolCallId);
    if (matched !== null) {
      removePendingIndex(pendingByName, event.toolName, matched);
      return matched;
    }
  }
  return popPendingIndex(pendingByName, event.toolName);
}

function readCachedRunAudit(cacheKey: string, nowMs: number): RunAuditResponse | null {
  const cached = runAuditCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= nowMs) {
    runAuditCache.delete(cacheKey);
    return null;
  }
  // Move-to-back by reinserting to keep insertion order as LRU recency.
  runAuditCache.delete(cacheKey);
  runAuditCache.set(cacheKey, cached);
  return cached.value;
}

function writeCachedRunAudit(cacheKey: string, value: RunAuditResponse, nowMs: number): void {
  runAuditCache.set(cacheKey, {
    expiresAt: nowMs + RUN_CACHE_TTL_MS,
    value,
  });
  while (runAuditCache.size > RUN_CACHE_MAX_ENTRIES) {
    const oldest = runAuditCache.keys().next().value as string | undefined;
    if (!oldest) {
      break;
    }
    runAuditCache.delete(oldest);
  }
}

async function readAuditFileText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function resolveAgentAuditLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ADJUTANT_AGENT_AUDIT_LOG_PATH?.trim();
  if (configured) {
    return resolve(configured);
  }
  return join(resolveAdjutantStateDir({ env }), AGENT_AUDIT_DEFAULT_RELATIVE_PATH);
}

export async function readRunAudit(
  runId: string,
  opts?: { auditLogPath?: string }
): Promise<RunAuditResponse> {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return { runId: "", runEnded: false, tools: [] };
  }

  const auditLogPath = resolve(opts?.auditLogPath ?? resolveAgentAuditLogPath());
  const cacheKey = `${auditLogPath}\u0000${normalizedRunId}`;
  const nowMs = nowMsFn();
  const cached = readCachedRunAudit(cacheKey, nowMs);
  if (cached) {
    return cached;
  }

  const raw = await readAuditFileText(auditLogPath);
  if (!raw) {
    return { runId: normalizedRunId, runEnded: false, tools: [] };
  }

  let origin: AuditOrigin | undefined;
  let sawRunEnd = false;
  const tools: AuditToolSummary[] = [];
  const pendingByCallId = new Map<string, number[]>();
  const pendingByName = new Map<string, number[]>();

  const lines = raw.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      continue;
    }
    const parsed = parseAuditLine(line, index + 1);
    if (!parsed || parsed.runId !== normalizedRunId) {
      continue;
    }
    if (parsed.type === "run.start") {
      origin = parsed.origin ?? origin;
      continue;
    }

    if (parsed.type === "run.end") {
      sawRunEnd = true;
      continue;
    }
    if (parsed.type === "message.bind") {
      continue;
    }

    if (parsed.type === "tool.start") {
      const toolIndex = tools.length;
      tools.push({
        toolName: parsed.toolName,
        toolCallId: parsed.toolCallId,
        args: parsed.args,
        truncated: parsed.truncated,
        startedAt: parsed.ts,
      });
      pushPendingIndex(pendingByName, parsed.toolName, toolIndex);
      if (parsed.toolCallId) {
        pushPendingIndex(pendingByCallId, parsed.toolCallId, toolIndex);
      }
      continue;
    }

    const matchedIndex = resolveToolMatchIndex(parsed, pendingByCallId, pendingByName);
    if (matchedIndex === null) {
      tools.push({
        toolName: parsed.toolName,
        toolCallId: parsed.toolCallId,
        resultSummary: parsed.resultSummary,
        status: parsed.status,
        durationMs: parsed.durationMs,
        truncated: parsed.truncated,
        error: parsed.error,
        endedAt: parsed.ts,
      });
      continue;
    }

    const matched = tools[matchedIndex];
    if (!matched) {
      continue;
    }
    matched.toolCallId = matched.toolCallId ?? parsed.toolCallId;
    if (parsed.resultSummary !== undefined) {
      matched.resultSummary = parsed.resultSummary;
    }
    matched.status = parsed.status ?? matched.status;
    matched.durationMs = parsed.durationMs ?? matched.durationMs;
    matched.error = parsed.error ?? matched.error;
    matched.endedAt = parsed.ts ?? matched.endedAt;
    if (parsed.truncated) {
      matched.truncated = true;
    }
  }

  const result = {
    runId: normalizedRunId,
    ...(origin ? { origin } : {}),
    runEnded: sawRunEnd,
    tools,
  } satisfies RunAuditResponse;
  if (sawRunEnd) {
    writeCachedRunAudit(cacheKey, result, nowMs);
  }
  return result;
}

export async function readAuditRunMetadata(opts?: {
  auditLogPath?: string;
}): Promise<AuditRunMetadata> {
  const auditLogPath = resolve(opts?.auditLogPath ?? resolveAgentAuditLogPath());
  const raw = await readAuditFileText(auditLogPath);
  if (!raw) {
    return {
      toolEndCountByRunId: new Map<string, number>(),
      messageRunIdByMessageId: new Map<string, string>(),
    };
  }

  const toolEndCountByRunId = new Map<string, number>();
  const messageRunIdByMessageId = new Map<string, string>();

  const lines = raw.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      continue;
    }
    const parsed = parseAuditLine(line, index + 1);
    if (!parsed) {
      continue;
    }
    if (parsed.type === "message.bind") {
      messageRunIdByMessageId.set(parsed.messageId, parsed.runId);
      continue;
    }
    if (parsed.type === "tool.end") {
      const count = toolEndCountByRunId.get(parsed.runId) ?? 0;
      toolEndCountByRunId.set(parsed.runId, count + 1);
    }
  }

  return { toolEndCountByRunId, messageRunIdByMessageId };
}

export function resetAuditReaderCacheForTest(): void {
  runAuditCache.clear();
}

export function setAuditReaderNowMsForTest(now: (() => number) | null): void {
  nowMsFn = now ?? (() => Date.now());
}
