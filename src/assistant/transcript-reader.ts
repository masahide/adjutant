import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { readAuditRunMetadata, resolveAgentAuditLogPath } from "./audit-reader.js";
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
  heartbeatPromptMarker?: string;
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

type TerminalRunRange = {
  runId: string;
  startMs: number;
  endMs: number;
};

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

function parseMsFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function resolveTerminalActionCandidates(sessionEntriesPath: string): string[] {
  const sessionsDir = dirname(sessionEntriesPath);
  const candidates = new Set<string>();
  candidates.add(join(sessionsDir, "main.jsonl"));

  const transcriptDir = process.env.ADJUTANT_TRANSCRIPTS_DIR?.trim();
  if (transcriptDir) {
    candidates.add(join(transcriptDir, "main.jsonl"));
  }
  return Array.from(candidates);
}

async function readTerminalRunRanges(params: {
  sessionEntriesPath: string;
  sessionKey: string;
}): Promise<TerminalRunRange[]> {
  const raw = await readFirstExistingTranscriptFile(
    resolveTerminalActionCandidates(params.sessionEntriesPath)
  );
  if (!raw) {
    return [];
  }

  const runRanges = new Map<string, TerminalRunRange>();
  const lines = raw.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      warnMalformedLine(index + 1);
      continue;
    }

    if (parsed.recordType !== "action") {
      continue;
    }

    const actionType = typeof parsed.actionType === "string" ? parsed.actionType : "";
    if (
      actionType !== "assistant_final" &&
      actionType !== "assistant_aborted" &&
      actionType !== "assistant_error"
    ) {
      continue;
    }

    const role = typeof parsed.role === "string" ? parsed.role : "";
    if (role !== "assistant") {
      continue;
    }

    const recordSessionKey = typeof parsed.sessionKey === "string" ? parsed.sessionKey.trim() : "";
    if (recordSessionKey && recordSessionKey !== params.sessionKey) {
      continue;
    }

    const runId = typeof parsed.runId === "string" ? parsed.runId.trim() : "";
    if (!runId) {
      continue;
    }

    const endMs = parseMsFromUnknown(parsed.ts);
    if (endMs === null) {
      continue;
    }

    const durationMsRaw = parsed.durationMs;
    const durationMs =
      typeof durationMsRaw === "number" && Number.isFinite(durationMsRaw) && durationMsRaw >= 0
        ? Math.floor(durationMsRaw)
        : null;
    const startMs = durationMs !== null ? Math.max(0, endMs - durationMs) : endMs;

    const existing = runRanges.get(runId);
    if (!existing) {
      runRanges.set(runId, { runId, startMs, endMs });
      continue;
    }
    runRanges.set(runId, {
      runId,
      startMs: Math.min(existing.startMs, startMs),
      endMs: Math.max(existing.endMs, endMs),
    });
  }

  return Array.from(runRanges.values()).sort((left, right) => {
    if (left.endMs !== right.endMs) {
      return left.endMs - right.endMs;
    }
    if (left.startMs !== right.startMs) {
      return left.startMs - right.startMs;
    }
    return left.runId.localeCompare(right.runId);
  });
}

function createTerminalRunIdMatcher(
  ranges: TerminalRunRange[]
): (timestamp: number) => string | undefined {
  if (ranges.length === 0) {
    return () => undefined;
  }
  const assigned = new Set<string>();
  const rangeSlackMs = 2500;
  const nearestSlackMs = 15000;

  return (timestamp) => {
    let matched: TerminalRunRange | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const range of ranges) {
      if (assigned.has(range.runId)) {
        continue;
      }
      if (timestamp < range.startMs - rangeSlackMs || timestamp > range.endMs + rangeSlackMs) {
        continue;
      }
      const score = Math.abs(range.endMs - timestamp);
      if (score < bestScore) {
        bestScore = score;
        matched = range;
      }
    }

    if (!matched) {
      for (const range of ranges) {
        if (assigned.has(range.runId)) {
          continue;
        }
        const score = Math.abs(range.endMs - timestamp);
        if (score > nearestSlackMs || score >= bestScore) {
          continue;
        }
        bestScore = score;
        matched = range;
      }
    }

    if (!matched) {
      return undefined;
    }
    assigned.add(matched.runId);
    return matched.runId;
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

function isHeartbeatPrompt(text: string | undefined, marker: string): boolean {
  if (!text) {
    return false;
  }
  return text.trimStart().startsWith(marker);
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

export async function loadMessages(opts: TranscriptReadOptions): Promise<HistoryMessage[]> {
  const resolved = await resolveTranscript(opts.sessionKey, opts.sessionEntriesPath);
  if (!resolved) {
    return [];
  }

  const heartbeatPromptMarker = opts.heartbeatPromptMarker?.trim() || "# HEARTBEAT";
  const auditLogPath = opts.auditLogPath ?? resolveAgentAuditLogPath();

  let heartbeatRunIds = new Set<string>();
  let toolEndCountByRunId = new Map<string, number>();
  let messageRunIdByMessageId = new Map<string, string>();
  let terminalRunRanges: TerminalRunRange[] = [];
  try {
    const metadata = await readAuditRunMetadata({ auditLogPath });
    heartbeatRunIds = metadata.heartbeatRunIds;
    toolEndCountByRunId = metadata.toolEndCountByRunId;
    messageRunIdByMessageId = metadata.messageRunIdByMessageId;
  } catch (error) {
    console.warn("[TranscriptReader] failed to read audit metadata:", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    terminalRunRanges = await readTerminalRunRanges({
      sessionEntriesPath: resolved.sessionEntriesPath,
      sessionKey: opts.sessionKey,
    });
  } catch (error) {
    console.warn("[TranscriptReader] failed to read terminal action metadata:", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  const matchRunIdByTerminalTimestamp = createTerminalRunIdMatcher(terminalRunRanges);

  const projected: HistoryMessage[] = [];
  let heartbeatTurnActive = false;

  for (const parsed of resolved.lines) {
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

    const timestamp = extractTimestamp(parsed, message);
    const messageId = extractMessageId(parsed, message);
    const runIdFromPayload =
      extractRunId(parsed, message) ??
      (messageId ? messageRunIdByMessageId.get(messageId) : undefined);
    const runId =
      runIdFromPayload ??
      (role === "assistant" ? matchRunIdByTerminalTimestamp(timestamp) : undefined);
    const matchedHeartbeatRun = runId ? heartbeatRunIds.has(runId) : false;

    if (role === "user") {
      if (heartbeatTurnActive) {
        heartbeatTurnActive = false;
      }
      if (matchedHeartbeatRun || isHeartbeatPrompt(text, heartbeatPromptMarker)) {
        heartbeatTurnActive = true;
        continue;
      }
    } else if (matchedHeartbeatRun || heartbeatTurnActive) {
      heartbeatTurnActive = false;
      continue;
    }

    const historyMessage: HistoryMessage = {
      role,
      content: toHistoryContent(message, text),
      timestamp,
      ...(runId ? { runId } : {}),
    };

    if (role === "assistant" && runId) {
      const toolCount = toolEndCountByRunId.get(runId);
      if (typeof toolCount === "number") {
        historyMessage.toolCount = toolCount;
      }
    }

    projected.push(historyMessage);
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
