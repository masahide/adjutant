import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { AuditOrigin, AuditToolSummary, RunAuditResponse } from "./audit-reader.js";
import {
  getSessionEntry,
  readSessionEntryStore,
  type SessionEntryStore,
} from "./session-entry-store.js";
import type { PiTranscriptLine, SessionTranscriptEvent } from "./types.js";
import { extractTranscriptMessageText, normalizeTranscriptRole } from "./transcript-utils.js";

export type TranscriptReadOptions = {
  sessionKey: string;
  limit?: number;
  sessionEntriesPath?: string;
  auditLogPath?: string;
};

export type HistoryMessage = {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text: string }>;
  timestamp: number;
  runId?: string;
  toolCount?: number;
};

type ResolvedTranscript = {
  sessionId: string;
  sessionEntriesPath: string;
  lines: PiTranscriptLine[];
};

type ParsedRunContext = {
  runId: string;
};

type ParsedRunSummary = {
  runId: string;
  assistantMessageId?: string;
  toolCount?: number;
  tools: AuditToolSummary[];
  origin?: AuditOrigin;
};

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

function takeNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized >= 0 ? normalized : undefined;
}

function extractTimestamp(line: PiTranscriptLine, message: Record<string, unknown>): number {
  if (typeof line.timestamp === "string") {
    const parsed = Date.parse(line.timestamp);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  const messageTs = message.timestamp;
  if (typeof messageTs === "number" && Number.isFinite(messageTs)) {
    return messageTs;
  }
  if (typeof messageTs === "string") {
    const parsed = Date.parse(messageTs);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return Date.now();
}

function warnMalformedLine(lineNo: number): void {
  console.warn(`[TranscriptReader] malformed transcript line skipped at line=${lineNo}`);
}

function resolveSessionEntry(
  store: SessionEntryStore,
  sessionKey: string
): { sessionId: string; sessionFile?: string } | null {
  const entry = getSessionEntry(store, sessionKey);
  if (!entry) {
    return null;
  }

  const sessionId = typeof entry.sessionId === "string" ? entry.sessionId.trim() : "";
  if (!sessionId) {
    return null;
  }

  const sessionFile =
    typeof entry.sessionFile === "string" && entry.sessionFile.trim()
      ? entry.sessionFile.trim()
      : undefined;

  return { sessionId, sessionFile };
}

async function readFirstExistingTranscriptFile(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  return null;
}

function resolveTranscriptCandidates(params: {
  sessionId: string;
  sessionFile?: string;
  sessionEntriesPath: string;
}): string[] {
  const candidates = new Set<string>();
  const sessionEntriesDir = dirname(params.sessionEntriesPath);
  if (params.sessionFile) {
    const sessionFile = params.sessionFile.trim();
    if (sessionFile) {
      candidates.add(isAbsolute(sessionFile) ? sessionFile : join(sessionEntriesDir, sessionFile));
    }
  }
  candidates.add(join(sessionEntriesDir, `${params.sessionId}.jsonl`));

  const transcriptDir = process.env.ADJUTANT_TRANSCRIPTS_DIR?.trim();
  if (transcriptDir) {
    candidates.add(join(transcriptDir, `${params.sessionId}.jsonl`));
  }
  return Array.from(candidates);
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, Math.floor(limit as number));
}

function normalizeRecentLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 0;
  }
  return Math.max(0, Math.floor(limit));
}

function parseMessageLine(line: string, lineNo: number): PiTranscriptLine | null {
  try {
    return JSON.parse(line) as PiTranscriptLine;
  } catch {
    warnMalformedLine(lineNo);
    return null;
  }
}

function parseTranscriptLines(transcript: string): PiTranscriptLine[] {
  const parsedLines: PiTranscriptLine[] = [];
  const lines = transcript.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      continue;
    }
    const parsed = parseMessageLine(line, index + 1);
    if (parsed) {
      parsedLines.push(parsed);
    }
  }
  return parsedLines;
}

async function resolveTranscript(
  sessionKey: string,
  sessionEntriesPathOverride?: string
): Promise<ResolvedTranscript | null> {
  const { path: sessionEntriesPath, store } = await readSessionEntryStore(
    sessionEntriesPathOverride
  );
  const entry = resolveSessionEntry(store, sessionKey);
  if (!entry) {
    return null;
  }

  const transcript = await readFirstExistingTranscriptFile(
    resolveTranscriptCandidates({
      sessionId: entry.sessionId,
      sessionFile: entry.sessionFile,
      sessionEntriesPath,
    })
  );
  if (!transcript) {
    return null;
  }

  return {
    sessionId: entry.sessionId,
    sessionEntriesPath,
    lines: parseTranscriptLines(transcript),
  };
}

function extractRunId(
  line: PiTranscriptLine,
  message: Record<string, unknown>
): string | undefined {
  const lineRecord = line as Record<string, unknown>;
  const messageRecord = message as Record<string, unknown>;
  const messageMeta = messageRecord.metadata as Record<string, unknown> | undefined;
  const candidates = [
    lineRecord.runId,
    lineRecord.run_id,
    lineRecord.idempotencyKey,
    lineRecord.idempotency_key,
    messageRecord.runId,
    messageRecord.run_id,
    messageRecord.idempotencyKey,
    messageRecord.idempotency_key,
    messageMeta?.runId,
    messageMeta?.run_id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function extractMessageId(
  line: PiTranscriptLine,
  message: Record<string, unknown>
): string | undefined {
  const candidates = [line.id, message.id];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function toHistoryContent(
  message: Record<string, unknown>,
  fallbackText: string
): HistoryMessage["content"] {
  const raw = message.content;
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    const parts = raw
      .map((item) => {
        const record = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
        const type = typeof record?.type === "string" ? record.type : "text";
        const text = typeof record?.text === "string" ? record.text : "";
        const trimmed = text.trim();
        return trimmed ? { type, text } : null;
      })
      .filter((item): item is { type: string; text: string } => item !== null);
    if (parts.length > 0) {
      return parts;
    }
  }
  return fallbackText;
}

function parseRunContextCustom(line: PiTranscriptLine): ParsedRunContext | null {
  const record = line as Record<string, unknown>;
  if (record.type !== "custom" || record.customType !== "adjutant:run-context") {
    return null;
  }
  const data = asRecord(record.data);
  if (!data) {
    return null;
  }
  const runId = takeString(data.runId);
  if (!runId) {
    return null;
  }
  return { runId };
}

function parseRunSummaryTools(value: unknown): AuditToolSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized: AuditToolSummary[] = [];
  for (const raw of value) {
    const record = asRecord(raw);
    if (!record) {
      continue;
    }
    const toolName = takeString(record.toolName);
    if (!toolName) {
      continue;
    }
    const status = record.status === "ok" || record.status === "error" ? record.status : undefined;
    normalized.push({
      toolName,
      toolCallId: takeString(record.toolCallId),
      args: record.args,
      resultSummary: record.resultSummary,
      status,
      durationMs: takeNonNegativeInt(record.durationMs),
      truncated: typeof record.truncated === "boolean" ? record.truncated : undefined,
      error: takeString(record.error),
      startedAt: takeString(record.startedAt),
      endedAt: takeString(record.endedAt),
    });
  }
  return normalized;
}

function countCompletedTools(tools: AuditToolSummary[]): number {
  let count = 0;
  for (const tool of tools) {
    if (typeof tool.endedAt === "string" && tool.endedAt.trim()) {
      count += 1;
    }
  }
  return count;
}

function parseRunSummaryCustom(line: PiTranscriptLine): ParsedRunSummary | null {
  const record = line as Record<string, unknown>;
  if (record.type !== "custom" || record.customType !== "adjutant:run-summary") {
    return null;
  }
  const data = asRecord(record.data);
  if (!data) {
    return null;
  }
  const runId = takeString(data.runId);
  if (!runId) {
    return null;
  }
  const tools = parseRunSummaryTools(data.tools);
  const toolCount = takeNonNegativeInt(data.toolCount) ?? countCompletedTools(tools);
  const origin = data.origin;
  return {
    runId,
    assistantMessageId: takeString(data.assistantMessageId),
    ...(toolCount !== undefined ? { toolCount } : {}),
    tools,
    origin: origin === "user" || origin === "pipeline" || origin === "system" ? origin : undefined,
  };
}

function assignToolCount(messages: HistoryMessage[], index: number, toolCount: number): void {
  const message = messages[index];
  if (!message || message.role !== "assistant") {
    return;
  }
  message.toolCount = toolCount;
}

export async function loadMessages(opts: TranscriptReadOptions): Promise<HistoryMessage[]> {
  const resolved = await resolveTranscript(opts.sessionKey, opts.sessionEntriesPath);
  if (!resolved) {
    return [];
  }

  const projected: HistoryMessage[] = [];
  const assistantIndexByMessageId = new Map<string, number>();
  const latestAssistantIndexByRunId = new Map<string, number>();
  const pendingToolCountByAssistantId = new Map<string, { toolCount: number; runId: string }>();
  const pendingToolCountByRunId = new Map<string, number>();
  let heartbeatTurnActive = false;
  let pendingRunIdFromContext: string | undefined;

  for (const parsed of resolved.lines) {
    const lineRecord = parsed as Record<string, unknown>;
    if (lineRecord.type === "custom_message" && lineRecord.customType === "adjutant:heartbeat") {
      heartbeatTurnActive = true;
      continue;
    }

    const runContext = parseRunContextCustom(parsed);
    if (runContext) {
      pendingRunIdFromContext = runContext.runId;
      continue;
    }

    const runSummary = parseRunSummaryCustom(parsed);
    if (runSummary) {
      if (runSummary.assistantMessageId) {
        const assistantIndex = assistantIndexByMessageId.get(runSummary.assistantMessageId);
        if (assistantIndex !== undefined) {
          assignToolCount(
            projected,
            assistantIndex,
            runSummary.toolCount ?? runSummary.tools.length
          );
          const assistant = projected[assistantIndex];
          if (assistant && !assistant.runId) {
            assistant.runId = runSummary.runId;
          }
        } else {
          pendingToolCountByAssistantId.set(runSummary.assistantMessageId, {
            toolCount: runSummary.toolCount ?? runSummary.tools.length,
            runId: runSummary.runId,
          });
        }
      } else {
        const assistantIndex = latestAssistantIndexByRunId.get(runSummary.runId);
        if (assistantIndex !== undefined) {
          assignToolCount(
            projected,
            assistantIndex,
            runSummary.toolCount ?? runSummary.tools.length
          );
        } else {
          pendingToolCountByRunId.set(
            runSummary.runId,
            runSummary.toolCount ?? runSummary.tools.length
          );
        }
      }
      continue;
    }

    if (!parsed.message || typeof parsed.message !== "object") {
      continue;
    }

    const message = parsed.message as Record<string, unknown>;
    const role = normalizeTranscriptRole(message.role);
    if (role !== "user" && role !== "assistant") {
      continue;
    }

    const text = extractTranscriptMessageText(message) ?? "";
    if (!text.trim()) {
      continue;
    }

    if (role === "user") {
      if (heartbeatTurnActive) {
        heartbeatTurnActive = false;
      }
    } else if (heartbeatTurnActive) {
      heartbeatTurnActive = false;
      continue;
    }

    const timestamp = extractTimestamp(parsed, message);
    const messageId = extractMessageId(parsed, message);
    const runIdFromPayload = extractRunId(parsed, message);
    const runId =
      runIdFromPayload ??
      (role === "assistant" && pendingRunIdFromContext ? pendingRunIdFromContext : undefined);
    if (role === "assistant" && pendingRunIdFromContext) {
      pendingRunIdFromContext = undefined;
    }

    const historyMessage: HistoryMessage = {
      role,
      content: toHistoryContent(message, text),
      timestamp,
      ...(runId ? { runId } : {}),
    };
    projected.push(historyMessage);
    const messageIndex = projected.length - 1;

    if (role === "assistant") {
      if (messageId) {
        assistantIndexByMessageId.set(messageId, messageIndex);
        const pendingById = pendingToolCountByAssistantId.get(messageId);
        if (pendingById) {
          assignToolCount(projected, messageIndex, pendingById.toolCount);
          if (!projected[messageIndex]?.runId) {
            projected[messageIndex]!.runId = pendingById.runId;
          }
          pendingToolCountByAssistantId.delete(messageId);
        }
      }
      if (runId) {
        latestAssistantIndexByRunId.set(runId, messageIndex);
        const pendingByRunId = pendingToolCountByRunId.get(runId);
        if (pendingByRunId !== undefined) {
          assignToolCount(projected, messageIndex, pendingByRunId);
          pendingToolCountByRunId.delete(runId);
        }
      }
    }
  }

  const limit = normalizeLimit(opts.limit);
  if (!Number.isFinite(limit)) {
    return projected;
  }
  if (limit === 0) {
    return [];
  }
  return projected.slice(-limit);
}

export async function readRunSummaryFromTranscript(opts: {
  sessionKey: string;
  runId: string;
  sessionEntriesPath?: string;
}): Promise<RunAuditResponse | null> {
  const normalizedRunId = opts.runId.trim();
  if (!normalizedRunId) {
    return null;
  }
  const resolved = await resolveTranscript(opts.sessionKey, opts.sessionEntriesPath);
  if (!resolved) {
    return null;
  }

  let latest: ParsedRunSummary | null = null;
  for (const line of resolved.lines) {
    const summary = parseRunSummaryCustom(line);
    if (!summary || summary.runId !== normalizedRunId) {
      continue;
    }
    latest = summary;
  }
  if (!latest) {
    return null;
  }
  return {
    runId: normalizedRunId,
    ...(latest.origin ? { origin: latest.origin } : {}),
    runEnded: true,
    tools: latest.tools,
  };
}

export async function loadRecentSessionEvents(
  opts: TranscriptReadOptions & { limit: number }
): Promise<SessionTranscriptEvent[]> {
  const resolved = await resolveTranscript(opts.sessionKey, opts.sessionEntriesPath);
  if (!resolved) {
    return [];
  }

  const parsedEvents: SessionTranscriptEvent[] = [];
  for (const parsed of resolved.lines) {
    if (!parsed.message || typeof parsed.message !== "object") {
      continue;
    }

    const message = parsed.message;
    const messageIdValue = parsed.id ?? (message as Record<string, unknown>).id;
    const messageId = typeof messageIdValue === "string" ? messageIdValue : undefined;
    const role = normalizeTranscriptRole((message as Record<string, unknown>).role);
    const text = extractTranscriptMessageText(message);
    const ts = extractTimestamp(parsed, message);

    parsedEvents.push({
      sessionKey: opts.sessionKey,
      sessionId: resolved.sessionId,
      messageId,
      ts,
      role,
      text,
      raw: parsed,
    });
  }

  const limit = normalizeRecentLimit(opts.limit);
  if (limit === 0) {
    return [];
  }
  return parsedEvents.slice(-limit);
}
