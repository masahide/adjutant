import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
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
};

type ResolvedTranscript = {
  sessionId: string;
  lines: PiTranscriptLine[];
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

async function resolveTranscript(sessionKey: string): Promise<ResolvedTranscript | null> {
  const { path: sessionEntriesPath, store } = await readSessionEntryStore();
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
    lines: parseTranscriptLines(transcript),
  };
}

export async function loadMessages(opts: TranscriptReadOptions): Promise<unknown[]> {
  const resolved = await resolveTranscript(opts.sessionKey);
  if (!resolved) {
    return [];
  }

  const projected: unknown[] = [];
  for (const parsed of resolved.lines) {
    if (parsed.message && typeof parsed.message === "object") {
      projected.push(parsed.message);
      continue;
    }

    if (parsed.type === "compaction") {
      const timestamp =
        typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Date.now();
      projected.push({
        role: "system",
        content: [{ type: "text", text: "Compaction" }],
        timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
      });
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

export async function loadRecentSessionEvents(
  opts: TranscriptReadOptions & { limit: number }
): Promise<SessionTranscriptEvent[]> {
  const resolved = await resolveTranscript(opts.sessionKey);
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
