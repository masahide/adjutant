import type { AgentAuditLog } from "./agent-audit-log.js";

export interface AuditToolSummary {
  toolName: string;
  toolCallId?: string;
  status?: "ok" | "error";
  args?: unknown;
  resultSummary?: unknown;
  error?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface RunAuditResponse {
  runId: string;
  sessionKey?: string;
  runEnded: boolean;
  runStatus?: "ok" | "aborted" | "error";
  stopReason?: string;
  error?: string;
  tools: AuditToolSummary[];
  summaryBatches: Array<{
    status: "ok" | "error";
    processedSessions?: number;
    writtenEntries?: number;
    skippedEntries?: number;
    warnings?: number;
    error?: string;
    ts?: string;
  }>;
}

type ParsedAuditEvent =
  | {
      type: "run.start";
      runId: string;
      sessionKey?: string;
    }
  | {
      type: "run.end";
      runId: string;
      status?: "ok" | "aborted" | "error";
      stopReason?: string;
      error?: string;
    }
  | {
      type: "tool.start";
      runId: string;
      toolName: string;
      toolCallId?: string;
      args?: unknown;
      ts?: string;
    }
  | {
      type: "tool.end";
      runId: string;
      toolName: string;
      toolCallId?: string;
      status?: "ok" | "error";
      resultSummary?: unknown;
      error?: string;
      ts?: string;
    }
  | {
      type: "summary.batch";
      runId: string;
      status?: "ok" | "error";
      processedSessions?: number;
      writtenEntries?: number;
      skippedEntries?: number;
      warnings?: number;
      error?: string;
      ts?: string;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
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

function parseAuditLine(rawLine: string): ParsedAuditEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null) {
    return null;
  }
  const type = takeString(record.type);
  const runId = takeString(record.runId);
  if (type === undefined || runId === undefined) {
    return null;
  }
  if (type === "run.start") {
    return {
      type,
      runId,
      sessionKey: takeString(record.sessionKey),
    };
  }
  if (type === "run.end") {
    return {
      type,
      runId,
      status:
        record.status === "ok" || record.status === "aborted" || record.status === "error"
          ? record.status
          : undefined,
      stopReason: takeString(record.stopReason),
      error: takeString(record.error),
    };
  }
  if (type === "tool.start" || type === "tool.end") {
    const toolName = takeString(record.toolName);
    if (toolName === undefined) {
      return null;
    }
    if (type === "tool.start") {
      return {
        type,
        runId,
        toolName,
        toolCallId: takeString(record.toolCallId),
        args: record.args,
        ts: takeString(record.ts),
      };
    }
    return {
      type,
      runId,
      toolName,
      toolCallId: takeString(record.toolCallId),
      status: record.status === "ok" || record.status === "error" ? record.status : undefined,
      resultSummary: record.resultSummary,
      error: takeString(record.error),
      ts: takeString(record.ts),
    };
  }
  if (type === "summary.batch") {
    const processedSessions =
      typeof record.processedSessions === "number" && Number.isFinite(record.processedSessions)
        ? record.processedSessions
        : undefined;
    const writtenEntries =
      typeof record.writtenEntries === "number" && Number.isFinite(record.writtenEntries)
        ? record.writtenEntries
        : undefined;
    const skippedEntries =
      typeof record.skippedEntries === "number" && Number.isFinite(record.skippedEntries)
        ? record.skippedEntries
        : undefined;
    const warnings =
      typeof record.warnings === "number" && Number.isFinite(record.warnings)
        ? record.warnings
        : undefined;
    return {
      type,
      runId,
      status: record.status === "ok" || record.status === "error" ? record.status : undefined,
      processedSessions,
      writtenEntries,
      skippedEntries,
      warnings,
      error: takeString(record.error),
      ts: takeString(record.ts),
    };
  }
  return null;
}

function pushPendingIndex(map: Map<string, number[]>, key: string, index: number): void {
  const existing = map.get(key);
  if (existing !== undefined) {
    existing.push(index);
    return;
  }
  map.set(key, [index]);
}

function popPendingIndex(map: Map<string, number[]>, key: string): number | null {
  const existing = map.get(key);
  if (existing === undefined || existing.length === 0) {
    return null;
  }
  const index = existing.pop();
  if (existing.length === 0) {
    map.delete(key);
  }
  return typeof index === "number" ? index : null;
}

function removePendingIndex(map: Map<string, number[]>, key: string, index: number): void {
  const existing = map.get(key);
  if (existing === undefined || existing.length === 0) {
    return;
  }
  const matched = existing.lastIndexOf(index);
  if (matched < 0) {
    return;
  }
  existing.splice(matched, 1);
  if (existing.length === 0) {
    map.delete(key);
  }
}

function resolveToolMatchIndex(
  event: Extract<ParsedAuditEvent, { type: "tool.end" }>,
  pendingByCallId: Map<string, number[]>,
  pendingByName: Map<string, number[]>
): number | null {
  if (event.toolCallId !== undefined) {
    const byCall = popPendingIndex(pendingByCallId, event.toolCallId);
    if (byCall !== null) {
      removePendingIndex(pendingByName, event.toolName, byCall);
      return byCall;
    }
  }
  return popPendingIndex(pendingByName, event.toolName);
}

export async function readRunAudit(runId: string, log: AgentAuditLog): Promise<RunAuditResponse> {
  const normalizedRunId = runId.trim();
  if (normalizedRunId.length === 0) {
    return { runId: "", runEnded: false, tools: [], summaryBatches: [] };
  }

  const raw = await log.readRaw();
  if (!raw) {
    return { runId: normalizedRunId, runEnded: false, tools: [], summaryBatches: [] };
  }

  let sessionKey: string | undefined;
  let runEnded = false;
  let runStatus: "ok" | "aborted" | "error" | undefined;
  let stopReason: string | undefined;
  let error: string | undefined;
  const tools: AuditToolSummary[] = [];
  const summaryBatches: RunAuditResponse["summaryBatches"] = [];
  const pendingByCallId = new Map<string, number[]>();
  const pendingByName = new Map<string, number[]>();

  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const parsed = parseAuditLine(line);
    if (parsed === null || parsed.runId !== normalizedRunId) {
      continue;
    }

    if (parsed.type === "run.start") {
      sessionKey = parsed.sessionKey ?? sessionKey;
      continue;
    }
    if (parsed.type === "run.end") {
      runEnded = true;
      runStatus = parsed.status ?? runStatus;
      stopReason = parsed.stopReason ?? stopReason;
      error = parsed.error ?? error;
      continue;
    }
    if (parsed.type === "tool.start") {
      const index = tools.length;
      tools.push({
        toolName: parsed.toolName,
        toolCallId: parsed.toolCallId,
        args: parsed.args,
        startedAt: parsed.ts,
      });
      pushPendingIndex(pendingByName, parsed.toolName, index);
      if (parsed.toolCallId !== undefined) {
        pushPendingIndex(pendingByCallId, parsed.toolCallId, index);
      }
      continue;
    }

    if (parsed.type === "summary.batch") {
      summaryBatches.push({
        status: parsed.status ?? "error",
        processedSessions: parsed.processedSessions,
        writtenEntries: parsed.writtenEntries,
        skippedEntries: parsed.skippedEntries,
        warnings: parsed.warnings,
        error: parsed.error,
        ts: parsed.ts,
      });
      continue;
    }

    const matched = resolveToolMatchIndex(parsed, pendingByCallId, pendingByName);
    if (matched === null) {
      tools.push({
        toolName: parsed.toolName,
        toolCallId: parsed.toolCallId,
        status: parsed.status,
        resultSummary: parsed.resultSummary,
        error: parsed.error,
        endedAt: parsed.ts,
      });
      continue;
    }

    const target = tools[matched];
    if (target === undefined) {
      continue;
    }
    target.toolCallId = target.toolCallId ?? parsed.toolCallId;
    target.status = parsed.status ?? target.status;
    target.resultSummary = parsed.resultSummary ?? target.resultSummary;
    target.error = parsed.error ?? target.error;
    target.endedAt = parsed.ts ?? target.endedAt;
  }

  return {
    runId: normalizedRunId,
    sessionKey,
    runEnded,
    runStatus,
    stopReason,
    error,
    tools,
    summaryBatches,
  };
}
