import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const AGENT_AUDIT_SCHEMA = "adjutant.agent.audit.v1";
const DEFAULT_AUDIT_RELATIVE_PATH = join("audit", "agent-audit.ndjson");

export type AgentAuditRunStatus = "ok" | "aborted" | "error";
export type AgentAuditToolStatus = "ok" | "error";

export interface AgentAuditRunStartInput {
  runId: string;
  sessionKey: string;
  sessionId?: string;
}

export interface AgentAuditRunEndInput {
  runId: string;
  sessionKey: string;
  status: AgentAuditRunStatus;
  stopReason?: string;
  error?: string;
}

export interface AgentAuditToolStartInput {
  runId: string;
  sessionKey: string;
  toolName: string;
  toolCallId?: string;
  args?: unknown;
}

export interface AgentAuditToolEndInput {
  runId: string;
  sessionKey: string;
  toolName: string;
  toolCallId?: string;
  status: AgentAuditToolStatus;
  resultSummary?: unknown;
  error?: string;
}

export interface AgentAuditSummaryBatchInput {
  runId: string;
  sessionKey: string;
  status: "ok" | "error";
  processedSessions?: number;
  writtenEntries?: number;
  skippedEntries?: number;
  warnings?: number;
  error?: string;
}

type AgentAuditEvent =
  | {
      schema: typeof AGENT_AUDIT_SCHEMA;
      type: "run.start";
      ts: string;
      runId: string;
      sessionKey: string;
      sessionId?: string;
    }
  | {
      schema: typeof AGENT_AUDIT_SCHEMA;
      type: "run.end";
      ts: string;
      runId: string;
      sessionKey: string;
      status: AgentAuditRunStatus;
      stopReason?: string;
      error?: string;
    }
  | {
      schema: typeof AGENT_AUDIT_SCHEMA;
      type: "tool.start";
      ts: string;
      runId: string;
      sessionKey: string;
      toolName: string;
      toolCallId?: string;
      args?: unknown;
    }
  | {
      schema: typeof AGENT_AUDIT_SCHEMA;
      type: "tool.end";
      ts: string;
      runId: string;
      sessionKey: string;
      toolName: string;
      toolCallId?: string;
      status: AgentAuditToolStatus;
      resultSummary?: unknown;
      error?: string;
    }
  | {
      schema: typeof AGENT_AUDIT_SCHEMA;
      type: "summary.batch";
      ts: string;
      runId: string;
      sessionKey: string;
      toolCallId: "summary_batch";
      status: "ok" | "error";
      processedSessions?: number;
      writtenEntries?: number;
      skippedEntries?: number;
      warnings?: number;
      error?: string;
    };

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function toReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  return fallback;
}

function resolveAuditLogPath(stateDir: string, env: NodeJS.ProcessEnv): string {
  const configured = env.ADJUTANT_AGENT_AUDIT_LOG_PATH?.trim();
  if (configured) {
    return resolve(configured);
  }
  return resolve(stateDir, DEFAULT_AUDIT_RELATIVE_PATH);
}

export interface AgentAuditLogOptions {
  enabled: boolean;
  path: string;
  now?: () => Date;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface AgentAuditLogFactoryOptions {
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
}

export class AgentAuditLog {
  private readonly enabled: boolean;
  private readonly path: string;
  private readonly now: () => Date;
  private readonly onWarn: (message: string, meta?: Record<string, unknown>) => void;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: AgentAuditLogOptions) {
    this.enabled = options.enabled;
    this.path = resolve(options.path);
    this.now = options.now ?? (() => new Date());
    this.onWarn = options.onWarn ?? (() => {});
  }

  static fromStateDir(
    stateDir: string,
    env: NodeJS.ProcessEnv = process.env,
    options?: AgentAuditLogFactoryOptions
  ): AgentAuditLog {
    return new AgentAuditLog({
      enabled: parseBoolean(env.ADJUTANT_AGENT_AUDIT_LOG_ENABLED, true),
      path: resolveAuditLogPath(stateDir, env),
      onWarn:
        options?.onWarn ??
        ((message, meta) => {
          const payload = {
            ts: new Date().toISOString(),
            event: message,
            runId: typeof meta?.runId === "string" ? meta.runId : null,
            sessionKey: typeof meta?.sessionKey === "string" ? meta.sessionKey : null,
            toolCallId: typeof meta?.toolCallId === "string" ? meta.toolCallId : null,
            details: meta ?? {},
          };
          process.stderr.write(`[agent-audit] ${safeStringify(payload) ?? "{}"}\n`);
        }),
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  pathForDebug(): string {
    return this.path;
  }

  appendRunStart(input: AgentAuditRunStartInput): void {
    this.append({
      schema: AGENT_AUDIT_SCHEMA,
      type: "run.start",
      ts: this.now().toISOString(),
      runId: input.runId,
      sessionKey: input.sessionKey,
      sessionId: input.sessionId,
    });
  }

  appendRunEnd(input: AgentAuditRunEndInput): void {
    this.append({
      schema: AGENT_AUDIT_SCHEMA,
      type: "run.end",
      ts: this.now().toISOString(),
      runId: input.runId,
      sessionKey: input.sessionKey,
      status: input.status,
      stopReason: input.stopReason,
      error: input.error,
    });
  }

  appendToolStart(input: AgentAuditToolStartInput): void {
    this.append({
      schema: AGENT_AUDIT_SCHEMA,
      type: "tool.start",
      ts: this.now().toISOString(),
      runId: input.runId,
      sessionKey: input.sessionKey,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      args: input.args,
    });
  }

  appendToolEnd(input: AgentAuditToolEndInput): void {
    this.append({
      schema: AGENT_AUDIT_SCHEMA,
      type: "tool.end",
      ts: this.now().toISOString(),
      runId: input.runId,
      sessionKey: input.sessionKey,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      status: input.status,
      resultSummary: input.resultSummary,
      error: input.error,
    });
  }

  appendSummaryBatch(input: AgentAuditSummaryBatchInput): void {
    this.append({
      schema: AGENT_AUDIT_SCHEMA,
      type: "summary.batch",
      ts: this.now().toISOString(),
      runId: input.runId,
      sessionKey: input.sessionKey,
      toolCallId: "summary_batch",
      status: input.status,
      processedSessions: input.processedSessions,
      writtenEntries: input.writtenEntries,
      skippedEntries: input.skippedEntries,
      warnings: input.warnings,
      error: input.error,
    });
  }

  async flush(): Promise<void> {
    await this.writeTail;
  }

  async readRaw(): Promise<string | null> {
    try {
      return await readFile(this.path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private append(event: AgentAuditEvent): void {
    if (!this.enabled) {
      return;
    }
    const serialized = safeStringify(event);
    if (serialized === null) {
      this.onWarn("agent-audit-serialize-failed", {
        type: event.type,
        runId: event.runId,
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
      });
    });
  }

  private async appendLineWithRetry(line: string): Promise<void> {
    try {
      await appendFile(this.path, line, "utf8");
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, line, "utf8");
  }
}
