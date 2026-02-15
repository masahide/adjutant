import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { PiTranscriptLine, SessionTranscriptEvent } from "./types.js";
import { extractTranscriptMessageText, normalizeTranscriptRole } from "./transcript-utils.js";

export type TranscriptReadOptions = {
  sessionKey: string;
  limit?: number;
};

type SessionEntryStore = Record<string, { sessionId?: unknown; sessionFile?: unknown }>;

function resolveSessionEntriesPath(): string {
  const configured = process.env.ADJUTANT_SESSION_ENTRIES_PATH?.trim();
  if (configured) {
    return configured;
  }
  return join(process.cwd(), "data", "_assistant", "sessions.json");
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

async function readSessionEntryStore(sessionEntriesPath: string): Promise<SessionEntryStore> {
  let raw: string;
  try {
    raw = await readFile(sessionEntriesPath, "utf8");
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return {};
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as SessionEntryStore;
  } catch {
    return {};
  }
}

function resolveSessionEntry(
  store: SessionEntryStore,
  sessionKey: string
): { sessionId: string; sessionFile?: string } | null {
  const key = sessionKey.trim();
  if (!key) {
    return null;
  }

  const entry = store[key];
  if (!entry || typeof entry !== "object") {
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

export async function loadMessages(opts: TranscriptReadOptions): Promise<unknown[]> {
  const sessionEntriesPath = resolveSessionEntriesPath();
  const store = await readSessionEntryStore(sessionEntriesPath);
  const entry = resolveSessionEntry(store, opts.sessionKey);
  if (!entry) {
    return [];
  }

  const transcript = await readFirstExistingTranscriptFile(
    resolveTranscriptCandidates({
      sessionId: entry.sessionId,
      sessionFile: entry.sessionFile,
      sessionEntriesPath,
    })
  );
  if (!transcript) {
    return [];
  }

  const projected: unknown[] = [];
  const lines = transcript.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      continue;
    }
    const parsed = parseMessageLine(line, index + 1);
    if (!parsed) {
      continue;
    }

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
  const sessionEntriesPath = resolveSessionEntriesPath();
  const store = await readSessionEntryStore(sessionEntriesPath);
  const entry = resolveSessionEntry(store, opts.sessionKey);
  if (!entry) {
    return [];
  }

  const transcript = await readFirstExistingTranscriptFile(
    resolveTranscriptCandidates({
      sessionId: entry.sessionId,
      sessionFile: entry.sessionFile,
      sessionEntriesPath,
    })
  );
  if (!transcript) {
    return [];
  }

  const parsedEvents: SessionTranscriptEvent[] = [];
  const lines = transcript.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      continue;
    }
    const parsed = parseMessageLine(line, index + 1);
    if (!parsed || !parsed.message || typeof parsed.message !== "object") {
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
      sessionId: entry.sessionId,
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
