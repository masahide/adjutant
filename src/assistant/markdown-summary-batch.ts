import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

export const SUMMARY_BATCH_WATERMARK_SCHEMA_V1 = "adjutant.summary.batch.watermark.v1";

type SummaryLine = {
  role: "user" | "assistant";
  text: string;
  tsIso?: string;
  sessionKey?: string;
};

type ParsedSummaryLine = SummaryLine & {
  endOffset: number;
};

type SessionFileCandidate = {
  filePath: string;
  watermarkKey: string;
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
  runOnce: (
    overrides?: Partial<
      Pick<
        MarkdownSummaryBatchRunOptions,
        | "workspaceDir"
        | "timezone"
        | "sessionTranscriptsDir"
        | "watermarkPath"
        | "messages"
        | "maxSessions"
        | "now"
      >
    >
  ) => Promise<MarkdownSummaryBatchResult>;
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
  return parts.join(" ");
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

function extractSummaryLine(entry: Record<string, unknown>): SummaryLine | null {
  const messageLine = extractFromMessageLine(entry);
  if (messageLine) {
    return messageLine;
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
        console.warn("[MarkdownSummaryBatch] failed to cleanup tmp file", {
          runId: null,
          sessionKey: null,
          toolCallId: null,
          reason: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
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
      prefix = "\n\n";
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

function normalizeRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function createWatermarkKey(filePath: string, sessionsDir: string): string {
  const rel = relative(resolve(sessionsDir), resolve(filePath));
  if (!rel || rel.startsWith("..")) {
    return `state:${basename(filePath)}`;
  }
  return `state:${normalizeRelativePath(rel)}`;
}

function resolveWatermarkState(
  watermark: SummaryBatchWatermarkV1,
  candidate: SessionFileCandidate
): {
  key: string;
  state?: { lastProcessedOffset: number; lastProcessedTs?: string };
} {
  const current = watermark.sessions[candidate.watermarkKey];
  if (current) {
    return { key: candidate.watermarkKey, state: current };
  }
  return { key: candidate.watermarkKey };
}

function rankCandidateForScheduling(state?: {
  lastProcessedOffset: number;
  lastProcessedTs?: string;
}): number {
  if (!state?.lastProcessedTs) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(state.lastProcessedTs);
  if (!Number.isFinite(parsed)) {
    return Number.NEGATIVE_INFINITY;
  }
  return parsed;
}

function listJsonlLinesWithOffsets(
  raw: Buffer,
  fromOffset: number
): Array<{ line: string; endOffset: number }> {
  const lines: Array<{ line: string; endOffset: number }> = [];
  let cursor = fromOffset;
  while (cursor < raw.length) {
    const newlineIndex = raw.indexOf(0x0a, cursor);
    if (newlineIndex === -1) {
      const tailBuffer = raw.subarray(cursor, raw.length);
      const tailText = tailBuffer.toString("utf8").replace(/\r$/, "");
      lines.push({ line: tailText, endOffset: raw.length });
      break;
    }
    const lineBuffer = raw.subarray(cursor, newlineIndex);
    const text = lineBuffer.toString("utf8").replace(/\r$/, "");
    lines.push({ line: text, endOffset: newlineIndex + 1 });
    cursor = newlineIndex + 1;
  }
  return lines;
}

function formatDateKeyInTimezone(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date);
}

async function listJsonlFiles(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Array<{
      name: string;
      isDirectory: () => boolean;
      isFile: () => boolean;
    }>;
    try {
      entries = (await readdir(dir, {
        withFileTypes: true,
        encoding: "utf8",
      })) as Array<{
        name: string;
        isDirectory: () => boolean;
        isFile: () => boolean;
      }>;
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        out.push(path);
      }
    }
  }
  await walk(resolve(rootDir));
  return out;
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

  const candidatesByPath = new Map<string, SessionFileCandidate>();
  try {
    for (const filePath of await listJsonlFiles(options.sessionTranscriptsDir)) {
      const absolutePath = resolve(filePath);
      if (candidatesByPath.has(absolutePath)) {
        continue;
      }
      candidatesByPath.set(absolutePath, {
        filePath: absolutePath,
        watermarkKey: createWatermarkKey(absolutePath, options.sessionTranscriptsDir),
      });
    }
  } catch (error) {
    warn("markdown-summary-list-jsonl-failed", {
      dir: options.sessionTranscriptsDir,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const sessionFiles = Array.from(candidatesByPath.values())
    .sort((left, right) => {
      const leftRank = rankCandidateForScheduling(resolveWatermarkState(watermark, left).state);
      const rightRank = rankCandidateForScheduling(resolveWatermarkState(watermark, right).state);
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return left.filePath.localeCompare(right.filePath);
    })
    .slice(0, maxSessions);

  let processedSessions = 0;
  let writtenEntries = 0;
  let skippedEntries = 0;
  const nextWatermark: SummaryBatchWatermarkV1 = {
    schema: SUMMARY_BATCH_WATERMARK_SCHEMA_V1,
    updatedAt: now.toISOString(),
    sessions: { ...watermark.sessions },
  };

  for (const sessionFile of sessionFiles) {
    const filePath = sessionFile.filePath;
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

    const stateInfo = resolveWatermarkState(nextWatermark, sessionFile);
    const state = stateInfo.state;
    const previousOffset =
      typeof state?.lastProcessedOffset === "number" && Number.isFinite(state.lastProcessedOffset)
        ? Math.max(0, Math.floor(state.lastProcessedOffset))
        : 0;
    const offsetResetByTruncate = previousOffset > fileSize;
    if (offsetResetByTruncate) {
      warn("markdown-summary-offset-reset", {
        sessionKey: stateInfo.key,
        filePath,
        previousOffset,
        fileSize,
      });
    }

    const fromOffset = offsetResetByTruncate ? 0 : previousOffset;
    const nowIso = now.toISOString();
    if (fromOffset >= fileSize) {
      nextWatermark.sessions[stateInfo.key] = {
        lastProcessedOffset: fileSize,
        lastProcessedTs: nowIso,
      };
      continue;
    }

    const parsed: ParsedSummaryLine[] = [];
    let parsedSessionKey: string | undefined;
    for (const chunkLine of listJsonlLinesWithOffsets(raw, fromOffset)) {
      const line = chunkLine.line;
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
        parsed.push({
          ...extracted,
          endOffset: chunkLine.endOffset,
        });
        if (!parsedSessionKey && extracted.sessionKey) {
          parsedSessionKey = extracted.sessionKey;
        }
      } catch {
        skippedEntries += 1;
      }
    }

    const filtered = parsed.slice(-messages);
    if (filtered.length === 0) {
      nextWatermark.sessions[stateInfo.key] = {
        lastProcessedOffset: fileSize,
        lastProcessedTs: nowIso,
      };
      continue;
    }

    const sessionKey = parsedSessionKey || basename(filePath, ".jsonl");
    const sourcePath = toSourcePathLabel(filePath, [options.sessionTranscriptsDir]);
    let progressOffset = fromOffset;
    let progressTs = state?.lastProcessedTs ?? nowIso;
    let failed = false;

    let activeDateKey: string | null = null;
    let activeLines: string[] = [];
    let activeEndOffset = fromOffset;
    let activeLastTs = nowIso;

    const flushSegment = async (): Promise<boolean> => {
      if (!activeDateKey || activeLines.length === 0) {
        return true;
      }
      const markdown = buildSummaryEntry({
        sessionKey,
        sourcePath,
        lines: activeLines,
      });
      try {
        await appendDailySummary(options.workspaceDir, activeDateKey, markdown);
        writtenEntries += activeLines.length;
        progressOffset = activeEndOffset;
        progressTs = activeLastTs;
        return true;
      } catch (error) {
        warn("markdown-summary-write-failed", {
          dateKey: activeDateKey,
          sessionKey,
          sourcePath,
          reason: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    };

    for (const item of filtered) {
      const tsIso = item.tsIso ?? nowIso;
      const dateKey = formatDateKeyInTimezone(new Date(tsIso), options.timezone);
      const summaryLine = `${item.role}: ${collapseMarkdownLine(item.text)}`;

      if (activeDateKey === null) {
        activeDateKey = dateKey;
        activeLines = [summaryLine];
        activeEndOffset = item.endOffset;
        activeLastTs = tsIso;
        continue;
      }

      if (activeDateKey !== dateKey) {
        if (!(await flushSegment())) {
          failed = true;
          break;
        }
        activeDateKey = dateKey;
        activeLines = [summaryLine];
        activeEndOffset = item.endOffset;
        activeLastTs = tsIso;
        continue;
      }

      activeLines.push(summaryLine);
      activeEndOffset = item.endOffset;
      activeLastTs = tsIso;
    }

    if (!failed) {
      failed = !(await flushSegment());
    }

    if (failed) {
      nextWatermark.sessions[stateInfo.key] = {
        lastProcessedOffset: progressOffset,
        lastProcessedTs: progressOffset > fromOffset ? progressTs : nowIso,
      };
      continue;
    }

    nextWatermark.sessions[stateInfo.key] = {
      lastProcessedOffset: fileSize,
      lastProcessedTs: progressTs,
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
    runOnce: async (overrides) =>
      await runMarkdownSummaryBatch({ ...options, ...(overrides ?? {}) }),
  };
}
