import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { listJsonlFiles } from "../io/jsonl-recovery.js";
import { formatDateKeyInTimezone } from "./memory-paths.js";
import { resolveLegacyWorkspaceSessionsDir } from "./session-paths.js";

export const SUMMARY_BATCH_WATERMARK_SCHEMA_V1 = "adjutant.summary.batch.watermark.v1";

type SummaryLine = {
  role: "user" | "assistant";
  text: string;
  tsIso?: string;
  sessionKey?: string;
};

export type SummaryBatchWatermarkV1 = {
  schema: typeof SUMMARY_BATCH_WATERMARK_SCHEMA_V1;
  updatedAt: string;
  sessions: Record<
    string,
    {
      lastProcessedOffset: number;
      lastProcessedTs?: string;
    }
  >;
};

export type MarkdownSummaryBatchRunOptions = {
  workspaceDir: string;
  timezone: string;
  sessionTranscriptsDir: string;
  watermarkPath: string;
  messages?: number;
  maxSessions?: number;
  legacySessionTranscriptsDir?: string;
  now?: Date;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
};

export type MarkdownSummaryBatchResult = {
  processedSessions: number;
  writtenEntries: number;
  skippedEntries: number;
  warnings: number;
};

export type MarkdownSummaryBatchService = {
  runOnce: () => Promise<MarkdownSummaryBatchResult>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const text = (item as Record<string, unknown>).text;
      return typeof text === "string" ? text.trim() : "";
    })
    .filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join("\n");
}

function normalizeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isFinite(parsed)) {
      return undefined;
    }
    return new Date(parsed).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) {
      return undefined;
    }
    return parsed.toISOString();
  }
  return undefined;
}

function collapseMarkdownLine(text: string): string {
  return text
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isCommandText(text: string): boolean {
  return text.trim().startsWith("/");
}

function pickSessionKey(entry: Record<string, unknown>): string | undefined {
  const direct = asString(entry.sessionKey);
  if (direct) {
    return direct;
  }
  const nestedMessage = asRecord(entry.message);
  return asString(nestedMessage?.sessionKey);
}

function extractFromMessageLine(entry: Record<string, unknown>): SummaryLine | null {
  if (entry.type !== "message") {
    return null;
  }
  const message = asRecord(entry.message);
  if (!message) {
    return null;
  }
  const role = asString(message.role);
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  const text = normalizeText(message.content) ?? asString(message.text);
  if (!text || isCommandText(text)) {
    return null;
  }
  return {
    role,
    text,
    tsIso:
      normalizeIsoTimestamp(entry.timestamp) ??
      normalizeIsoTimestamp(message.timestamp) ??
      normalizeIsoTimestamp(entry.ts),
    sessionKey: pickSessionKey(entry),
  };
}

function extractFromTimelineLine(entry: Record<string, unknown>): SummaryLine | null {
  if (entry.recordType !== "event") {
    return null;
  }
  const role = asString(entry.role);
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  const kind = asString(entry.kind);
  if (kind && kind !== "post") {
    return null;
  }
  const eventRecord = asRecord(entry.event);
  const detail = asRecord(eventRecord?.detail);
  const slack = asRecord(detail?.slack);
  const text =
    asString(entry.text) ??
    normalizeText(entry.content) ??
    asString(slack?.text) ??
    asString(slack?.message_text);
  if (!text || isCommandText(text)) {
    return null;
  }
  return {
    role,
    text,
    tsIso: normalizeIsoTimestamp(entry.loggedAt) ?? normalizeIsoTimestamp(entry.ts),
    sessionKey: pickSessionKey(entry),
  };
}

function extractSummaryLine(entry: Record<string, unknown>): SummaryLine | null {
  const messageLine = extractFromMessageLine(entry);
  if (messageLine) {
    return messageLine;
  }
  const timelineLine = extractFromTimelineLine(entry);
  if (timelineLine) {
    return timelineLine;
  }
  const role = asString(entry.role);
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  const text = normalizeText(entry.content) ?? asString(entry.text);
  if (!text || isCommandText(text)) {
    return null;
  }
  return {
    role,
    text,
    tsIso: normalizeIsoTimestamp(entry.timestamp) ?? normalizeIsoTimestamp(entry.ts),
    sessionKey: pickSessionKey(entry),
  };
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value as number));
}

function createEmptyWatermark(now: Date): SummaryBatchWatermarkV1 {
  return {
    schema: SUMMARY_BATCH_WATERMARK_SCHEMA_V1,
    updatedAt: now.toISOString(),
    sessions: {},
  };
}

function normalizeWatermark(input: unknown, now: Date): SummaryBatchWatermarkV1 {
  const root = asRecord(input);
  if (!root || root.schema !== SUMMARY_BATCH_WATERMARK_SCHEMA_V1) {
    return createEmptyWatermark(now);
  }
  const sessionsInput = asRecord(root.sessions) ?? {};
  const sessions: SummaryBatchWatermarkV1["sessions"] = {};
  for (const [key, value] of Object.entries(sessionsInput)) {
    const entry = asRecord(value);
    if (!entry) {
      continue;
    }
    const offset =
      typeof entry.lastProcessedOffset === "number" && Number.isFinite(entry.lastProcessedOffset)
        ? Math.max(0, Math.floor(entry.lastProcessedOffset))
        : 0;
    const lastProcessedTs = asString(entry.lastProcessedTs);
    sessions[key] = lastProcessedTs
      ? { lastProcessedOffset: offset, lastProcessedTs }
      : { lastProcessedOffset: offset };
  }
  const updatedAt = asString(root.updatedAt) ?? now.toISOString();
  return {
    schema: SUMMARY_BATCH_WATERMARK_SCHEMA_V1,
    updatedAt,
    sessions,
  };
}

async function loadWatermark(path: string, now: Date): Promise<SummaryBatchWatermarkV1> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return createEmptyWatermark(now);
    }
    throw error;
  }
  try {
    return normalizeWatermark(JSON.parse(raw), now);
  } catch {
    return createEmptyWatermark(now);
  }
}

async function writeJsonAtomic(path: string, content: string): Promise<void> {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch (cleanupError) {
      const errno = cleanupError as NodeJS.ErrnoException;
      if (errno.code !== "ENOENT") {
        console.warn("[MarkdownSummaryBatch] failed to cleanup tmp file:", cleanupError);
      }
    }
    throw error;
  }
}

async function appendDailySummary(
  workspaceDir: string,
  dateKey: string,
  entry: string
): Promise<void> {
  const dailyDir = join(workspaceDir, "memory");
  const filePath = join(dailyDir, `${dateKey}.md`);
  await mkdir(dailyDir, { recursive: true });
  let prefix = "";
  try {
    const info = await stat(filePath);
    if (info.size > 0) {
      prefix = "\n";
    }
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT") {
      throw error;
    }
  }
  await appendFile(filePath, `${prefix}${entry}\n`, "utf8");
}

function toSourcePathLabel(filePath: string, roots: string[]): string {
  const absoluteFilePath = resolve(filePath);
  for (const root of roots) {
    const absoluteRoot = resolve(root);
    const rel = relative(absoluteRoot, absoluteFilePath);
    if (!rel.startsWith("..") && rel !== "") {
      return rel;
    }
  }
  return basename(filePath);
}

function buildSummaryEntry(params: {
  sessionKey: string;
  sourcePath: string;
  lines: string[];
}): string {
  return [
    "## Session Summary",
    "",
    `- Session Key: ${params.sessionKey}`,
    `- Source: ${params.sourcePath}`,
    ...params.lines.map((line) => `- ${line}`),
  ].join("\n");
}

export async function runMarkdownSummaryBatch(
  options: MarkdownSummaryBatchRunOptions
): Promise<MarkdownSummaryBatchResult> {
  const now = options.now ?? new Date();
  const messages = normalizePositiveInt(options.messages, 15);
  const maxSessions = normalizePositiveInt(options.maxSessions, 200);
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const warn = (message: string, meta?: Record<string, unknown>) => {
    warnings.push({ message, meta });
    options.onWarn?.(message, meta);
  };

  let watermark = createEmptyWatermark(now);
  try {
    watermark = await loadWatermark(options.watermarkPath, now);
  } catch (error) {
    warn("markdown-summary-watermark-load-failed", {
      path: options.watermarkPath,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const sourceDirs: string[] = [options.sessionTranscriptsDir];
  const legacyDir =
    options.legacySessionTranscriptsDir?.trim() ||
    resolveLegacyWorkspaceSessionsDir(options.workspaceDir);
  if (legacyDir !== options.sessionTranscriptsDir) {
    sourceDirs.push(legacyDir);
  }

  const uniqueFiles = new Set<string>();
  for (const dir of sourceDirs) {
    try {
      for (const filePath of await listJsonlFiles(dir)) {
        uniqueFiles.add(resolve(filePath));
      }
    } catch (error) {
      warn("markdown-summary-list-jsonl-failed", {
        dir,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const sessionFiles = Array.from(uniqueFiles).sort().slice(0, maxSessions);

  let processedSessions = 0;
  let writtenEntries = 0;
  let skippedEntries = 0;
  const nextWatermark: SummaryBatchWatermarkV1 = {
    schema: SUMMARY_BATCH_WATERMARK_SCHEMA_V1,
    updatedAt: now.toISOString(),
    sessions: { ...watermark.sessions },
  };

  for (const filePath of sessionFiles) {
    processedSessions += 1;
    let raw: Buffer;
    let fileSize = 0;
    try {
      raw = await readFile(filePath);
      fileSize = raw.length;
    } catch (error) {
      warn("markdown-summary-read-failed", {
        path: filePath,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const state = nextWatermark.sessions[filePath];
    const previousOffset =
      typeof state?.lastProcessedOffset === "number" && Number.isFinite(state.lastProcessedOffset)
        ? Math.max(0, Math.floor(state.lastProcessedOffset))
        : 0;
    const fromOffset = Math.min(previousOffset, fileSize);
    if (fromOffset >= fileSize) {
      continue;
    }

    const chunkText = raw.subarray(fromOffset).toString("utf8");
    const parsed: SummaryLine[] = [];
    let parsedSessionKey: string | undefined;
    const chunkLines = chunkText.split(/\r?\n/);
    for (const line of chunkLines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const candidate = JSON.parse(line) as unknown;
        const entry = asRecord(candidate);
        if (!entry) {
          skippedEntries += 1;
          continue;
        }
        const extracted = extractSummaryLine(entry);
        if (!extracted) {
          skippedEntries += 1;
          continue;
        }
        parsed.push(extracted);
        if (!parsedSessionKey && extracted.sessionKey) {
          parsedSessionKey = extracted.sessionKey;
        }
      } catch {
        skippedEntries += 1;
      }
    }

    const filtered = parsed.slice(-messages);
    if (filtered.length === 0) {
      nextWatermark.sessions[filePath] = {
        lastProcessedOffset: fileSize,
        lastProcessedTs: state?.lastProcessedTs,
      };
      continue;
    }

    const sessionKey = parsedSessionKey || basename(filePath, ".jsonl");
    const grouped = new Map<string, string[]>();
    let lastProcessedTs = state?.lastProcessedTs;
    for (const item of filtered) {
      const tsIso = item.tsIso ?? now.toISOString();
      lastProcessedTs = tsIso;
      const dateKey = formatDateKeyInTimezone(new Date(tsIso), options.timezone);
      const current = grouped.get(dateKey) ?? [];
      current.push(`${item.role}: ${collapseMarkdownLine(item.text)}`);
      grouped.set(dateKey, current);
    }

    const sourcePath = toSourcePathLabel(filePath, sourceDirs);
    let wroteAllGroups = true;
    for (const [dateKey, lines] of grouped.entries()) {
      const markdown = buildSummaryEntry({
        sessionKey,
        sourcePath,
        lines,
      });
      try {
        await appendDailySummary(options.workspaceDir, dateKey, markdown);
        writtenEntries += lines.length;
      } catch (error) {
        wroteAllGroups = false;
        warn("markdown-summary-write-failed", {
          dateKey,
          sessionKey,
          sourcePath,
          reason: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }

    if (!wroteAllGroups) {
      continue;
    }
    nextWatermark.sessions[filePath] = {
      lastProcessedOffset: fileSize,
      lastProcessedTs,
    };
  }

  try {
    await writeJsonAtomic(options.watermarkPath, JSON.stringify(nextWatermark, null, 2));
  } catch (error) {
    warn("markdown-summary-watermark-save-failed", {
      path: options.watermarkPath,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    processedSessions,
    writtenEntries,
    skippedEntries,
    warnings: warnings.length,
  };
}

export function createMarkdownSummaryBatchService(
  options: MarkdownSummaryBatchRunOptions
): MarkdownSummaryBatchService {
  return {
    runOnce: async () => await runMarkdownSummaryBatch(options),
  };
}
