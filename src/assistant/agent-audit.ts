import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const AGENT_AUDIT_SCHEMA = "adjutant.agent.audit.v1";
const REDACTED_VALUE = "***";
const SENSITIVE_KEY_PATTERN =
  /token|api[-_]?key|password|authorization|secret|cookie|session|credential/i;

export type AgentAuditScope = {
  runId: string;
  sessionKey: string;
};

type AgentAuditRunStatus = "ok" | "aborted" | "error";
type AgentAuditToolStatus = "ok" | "error";
type AgentAuditIoStatus = "ok" | "error";

type AgentAuditRunEvent = {
  schema: typeof AGENT_AUDIT_SCHEMA;
  type: "run.start" | "run.end";
  ts: string;
  runId: string;
  sessionKey: string;
  origin?: "user" | "pipeline" | "system";
  modelId?: string;
  status?: AgentAuditRunStatus;
  durationMs?: number;
  error?: string;
};

type AgentAuditToolEvent = {
  schema: typeof AGENT_AUDIT_SCHEMA;
  type: "tool.start" | "tool.end";
  ts: string;
  runId: string;
  sessionKey: string;
  toolName: string;
  toolCallId?: string;
  args?: unknown;
  resultSummary?: unknown;
  error?: string;
  status?: AgentAuditToolStatus;
  durationMs?: number;
  truncated?: boolean;
};

type AgentAuditFileEvent = {
  schema: typeof AGENT_AUDIT_SCHEMA;
  type: "file.read" | "file.write";
  ts: string;
  runId: string;
  sessionKey: string;
  path: string;
  operation: "read" | "write";
  bytes?: number;
  status: AgentAuditIoStatus;
  error?: string;
};

export type AgentAuditEvent = AgentAuditRunEvent | AgentAuditToolEvent | AgentAuditFileEvent;

export type ConfigureAgentAuditLoggerOptions = {
  enabled: boolean;
  path: string;
  maxFieldChars?: number;
  now?: () => Date;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
};

type AgentAuditLoggerOptions = {
  path: string;
  maxFieldChars: number;
  now: () => Date;
  onWarn: (message: string, meta?: Record<string, unknown>) => void;
};

type SanitizedField = {
  value: unknown;
  truncated: boolean;
};

class AgentAuditLogger {
  private readonly path: string;
  private readonly maxFieldChars: number;
  private readonly now: () => Date;
  private readonly onWarn: (message: string, meta?: Record<string, unknown>) => void;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: AgentAuditLoggerOptions) {
    this.path = resolve(options.path);
    this.maxFieldChars = Math.max(1, Math.floor(options.maxFieldChars));
    this.now = options.now;
    this.onWarn = options.onWarn;
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  sanitizeField(value: unknown): SanitizedField {
    const redacted = redactValue(value, new WeakSet<object>());
    const serialized = safeStringify(redacted);
    if (serialized === null) {
      return { value: "[[unserializable]]", truncated: false };
    }
    if (serialized.length <= this.maxFieldChars) {
      return { value: redacted, truncated: false };
    }
    const preview = toTruncatedPreview(serialized, this.maxFieldChars);
    if (typeof redacted === "string") {
      return {
        value: toTruncatedPreview(redacted, this.maxFieldChars),
        truncated: true,
      };
    }
    if (redacted !== null && typeof redacted === "object") {
      return {
        value: {
          _truncated: true,
          originalType: Array.isArray(redacted) ? "array" : "object",
          preview,
        },
        truncated: true,
      };
    }
    return {
      value: preview,
      truncated: true,
    };
  }

  appendSafe(event: AgentAuditEvent): void {
    const serialized = safeStringify(event);
    if (serialized === null) {
      this.onWarn("agent-audit-serialize-failed", {
        type: event.type,
        runId: event.runId,
        sessionKey: event.sessionKey,
      });
      return;
    }
    const line = `${serialized}\n`;
    const task = this.writeTail.then(async () => {
      await this.appendLineWithRetry(line);
    });
    this.writeTail = task.catch(() => undefined);
    void task.catch((error) => {
      this.onWarn("agent-audit-append-failed", {
        path: this.path,
        reason: toReason(error),
        type: event.type,
        runId: event.runId,
        sessionKey: event.sessionKey,
      });
    });
  }

  async flush(): Promise<void> {
    await this.writeTail;
  }

  private async appendLineWithRetry(line: string): Promise<void> {
    try {
      await appendFile(this.path, line, "utf8");
      return;
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code !== "ENOENT") {
        throw error;
      }
    }

    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, line, "utf8");
  }
}

let activeAgentAuditLogger: AgentAuditLogger | null = null;

function defaultAuditWarn(message: string, meta?: Record<string, unknown>): void {
  console.warn("[AgentAudit]", message, meta ?? {});
}

export function configureAgentAuditLogger(options: ConfigureAgentAuditLoggerOptions): void {
  if (!options.enabled) {
    activeAgentAuditLogger = null;
    return;
  }

  activeAgentAuditLogger = new AgentAuditLogger({
    path: options.path,
    maxFieldChars: Math.max(1, Math.floor(options.maxFieldChars ?? 4000)),
    now: options.now ?? (() => new Date()),
    onWarn: options.onWarn ?? defaultAuditWarn,
  });
}

export function resetAgentAuditLoggerForTest(): void {
  activeAgentAuditLogger = null;
}

export async function flushAgentAuditLoggerForTest(): Promise<void> {
  await activeAgentAuditLogger?.flush();
}

function withTs<T extends { ts: string }>(builder: (ts: string) => T): T | null {
  const logger = activeAgentAuditLogger;
  if (!logger) {
    return null;
  }
  return builder(logger.nowIso());
}

export function auditRunStart(input: {
  scope: AgentAuditScope;
  origin?: "user" | "pipeline" | "system";
  modelId?: string;
}): void {
  const event = withTs(
    (ts): AgentAuditRunEvent => ({
      schema: AGENT_AUDIT_SCHEMA,
      type: "run.start",
      ts,
      runId: input.scope.runId,
      sessionKey: input.scope.sessionKey,
      origin: input.origin,
      modelId: input.modelId,
    })
  );
  if (!event) {
    return;
  }
  activeAgentAuditLogger?.appendSafe(event);
}

export function auditRunEnd(input: {
  scope: AgentAuditScope;
  status: AgentAuditRunStatus;
  durationMs: number;
  modelId?: string;
  error?: string;
}): void {
  const logger = activeAgentAuditLogger;
  if (!logger) {
    return;
  }
  const sanitizedError = sanitizeErrorMessage(input.error, logger);
  const event: AgentAuditRunEvent = {
    schema: AGENT_AUDIT_SCHEMA,
    type: "run.end",
    ts: logger.nowIso(),
    runId: input.scope.runId,
    sessionKey: input.scope.sessionKey,
    status: input.status,
    durationMs: Math.max(0, Math.floor(input.durationMs)),
    modelId: input.modelId,
    ...(sanitizedError ? { error: sanitizedError } : {}),
  };
  logger.appendSafe(event);
}

export function auditToolStart(input: {
  scope: AgentAuditScope;
  toolName: string;
  toolCallId?: string;
  args?: unknown;
}): void {
  const logger = activeAgentAuditLogger;
  if (!logger) {
    return;
  }
  const argsField = logger.sanitizeField(input.args);
  const event: AgentAuditToolEvent = {
    schema: AGENT_AUDIT_SCHEMA,
    type: "tool.start",
    ts: logger.nowIso(),
    runId: input.scope.runId,
    sessionKey: input.scope.sessionKey,
    toolName: input.toolName,
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    ...(input.args !== undefined ? { args: argsField.value } : {}),
    ...(argsField.truncated ? { truncated: true } : {}),
  };
  logger.appendSafe(event);
}

export function auditToolEnd(input: {
  scope: AgentAuditScope;
  toolName: string;
  toolCallId?: string;
  resultSummary?: unknown;
  status: AgentAuditToolStatus;
  durationMs?: number;
  error?: string;
}): void {
  const logger = activeAgentAuditLogger;
  if (!logger) {
    return;
  }
  const resultField = logger.sanitizeField(input.resultSummary);
  const sanitizedError = sanitizeErrorMessage(input.error, logger);
  const event: AgentAuditToolEvent = {
    schema: AGENT_AUDIT_SCHEMA,
    type: "tool.end",
    ts: logger.nowIso(),
    runId: input.scope.runId,
    sessionKey: input.scope.sessionKey,
    toolName: input.toolName,
    status: input.status,
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    ...(input.durationMs !== undefined
      ? { durationMs: Math.max(0, Math.floor(input.durationMs)) }
      : {}),
    ...(input.resultSummary !== undefined ? { resultSummary: resultField.value } : {}),
    ...(sanitizedError ? { error: sanitizedError } : {}),
    ...(resultField.truncated ? { truncated: true } : {}),
  };
  logger.appendSafe(event);
}

export function auditFileRead(input: {
  scope?: AgentAuditScope;
  path: string;
  bytes?: number;
  status: AgentAuditIoStatus;
  error?: string;
}): void {
  auditFileEvent({
    scope: input.scope,
    type: "file.read",
    operation: "read",
    path: input.path,
    bytes: input.bytes,
    status: input.status,
    error: input.error,
  });
}

export function auditFileWrite(input: {
  scope?: AgentAuditScope;
  path: string;
  bytes?: number;
  status: AgentAuditIoStatus;
  error?: string;
}): void {
  auditFileEvent({
    scope: input.scope,
    type: "file.write",
    operation: "write",
    path: input.path,
    bytes: input.bytes,
    status: input.status,
    error: input.error,
  });
}

function auditFileEvent(input: {
  scope?: AgentAuditScope;
  type: "file.read" | "file.write";
  operation: "read" | "write";
  path: string;
  bytes?: number;
  status: AgentAuditIoStatus;
  error?: string;
}): void {
  const logger = activeAgentAuditLogger;
  if (!logger || !input.scope) {
    return;
  }
  const sanitizedError = sanitizeErrorMessage(input.error, logger);
  const event: AgentAuditFileEvent = {
    schema: AGENT_AUDIT_SCHEMA,
    type: input.type,
    ts: logger.nowIso(),
    runId: input.scope.runId,
    sessionKey: input.scope.sessionKey,
    path: input.path,
    operation: input.operation,
    status: input.status,
    ...(input.bytes !== undefined ? { bytes: Math.max(0, Math.floor(input.bytes)) } : {}),
    ...(sanitizedError ? { error: sanitizedError } : {}),
  };
  logger.appendSafe(event);
}

function sanitizeErrorMessage(
  message: string | undefined,
  logger: AgentAuditLogger
): string | undefined {
  if (!message) {
    return undefined;
  }
  const sanitized = logger.sanitizeField(message);
  if (typeof sanitized.value === "string" && sanitized.value.trim().length > 0) {
    return sanitized.value;
  }
  const serialized = safeStringify(sanitized.value);
  if (serialized && serialized.trim().length > 0) {
    return serialized;
  }
  return undefined;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "undefined") {
    return "[[undefined]]";
  }
  if (typeof value === "function") {
    return "[[function]]";
  }
  if (typeof value === "symbol") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    if (seen.has(objectValue)) {
      return "[[circular]]";
    }
    seen.add(objectValue);

    const normalized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(objectValue)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        normalized[key] = REDACTED_VALUE;
      } else {
        normalized[key] = redactValue(item, seen);
      }
    }
    return normalized;
  }
  return String(value);
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function toTruncatedPreview(value: string, maxChars: number): string {
  const limit = Math.max(1, Math.floor(maxChars));
  return `${value.slice(0, limit)}...(truncated)`;
}

function toReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
