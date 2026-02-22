import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WATERMARKS_SCHEMA_V1, type WatermarksV1 } from "./types.js";
import type { TimelineActionType } from "./types.js";

const DEFAULT_TIMELINE_PATH = "memory/timeline.jsonl";
const DEFAULT_WATERMARKS_PATH = join(process.cwd(), "memory", "watermarks.json");

export type WatermarkStoreOptions = {
  path?: string;
  timelinePath?: string;
  now?: () => Date;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
};

export type WatermarkStore = {
  load: () => Promise<WatermarksV1>;
  save: (next: WatermarksV1) => Promise<void>;
  setScanOffsets: (input: {
    lastScannedOffset: number;
    lastGoodOffset: number;
  }) => Promise<WatermarksV1>;
  advanceHandled: (
    sessionKey: string,
    input: { offset: number; ts?: string }
  ) => Promise<WatermarksV1>;
  updateOpenPosts: (
    sessionKey: string,
    input: { oldestOpenPostTs?: string; openPostCount?: number }
  ) => Promise<WatermarksV1>;
  pruneSessions: () => Promise<WatermarksV1>;
  recoverIfTimelineTruncated: () => Promise<{ recovered: boolean; watermarks: WatermarksV1 }>;
  applyTerminalRecord: (input: {
    sessionKey: string;
    actionType: TimelineActionType;
    offset: number;
    ts?: string;
  }) => Promise<WatermarksV1>;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toNonNegativeInt(value: unknown, fallback = 0): number {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return fallback;
  }
  return Math.max(0, Math.floor(normalized));
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function isIsoString(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function createDefaultWatermarks(timelinePath: string, now: Date): WatermarksV1 {
  return {
    schema: WATERMARKS_SCHEMA_V1,
    updatedAt: now.toISOString(),
    scan: {
      timelinePath,
      lastScannedOffset: 0,
      lastGoodOffset: 0,
    },
    sessions: {},
  };
}

function normalizeWatermarks(
  input: unknown,
  params: { timelinePath: string; now: Date }
): WatermarksV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return createDefaultWatermarks(params.timelinePath, params.now);
  }

  const source = input as Record<string, unknown>;
  const scan = source.scan as Record<string, unknown> | undefined;
  const sessionsInput =
    source.sessions && typeof source.sessions === "object" && !Array.isArray(source.sessions)
      ? (source.sessions as Record<string, unknown>)
      : {};

  const sessions: WatermarksV1["sessions"] = {};
  for (const [sessionKey, value] of Object.entries(sessionsInput)) {
    if (!sessionKey.trim() || !value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const entry = value as Record<string, unknown>;
    const handled = entry.handled as Record<string, unknown> | undefined;
    const open = entry.open as Record<string, unknown> | undefined;
    const lastHandledOffset = toNonNegativeInt(handled?.lastHandledOffset, Number.NaN);
    const openPostCount = toNonNegativeInt(open?.openPostCount, Number.NaN);
    sessions[sessionKey] = {
      handled: {
        lastHandledOffset: Number.isFinite(lastHandledOffset) ? lastHandledOffset : undefined,
        lastHandledTs: isIsoString(handled?.lastHandledTs) ? handled?.lastHandledTs : undefined,
      },
      open: {
        oldestOpenPostTs: isIsoString(open?.oldestOpenPostTs) ? open?.oldestOpenPostTs : undefined,
        openPostCount: Number.isFinite(openPostCount) ? openPostCount : undefined,
      },
    };
  }

  return {
    schema: WATERMARKS_SCHEMA_V1,
    updatedAt: isIsoString(source.updatedAt) ? source.updatedAt : params.now.toISOString(),
    scan: {
      timelinePath: normalizeString(scan?.timelinePath) ?? params.timelinePath,
      lastScannedOffset: toNonNegativeInt(scan?.lastScannedOffset),
      lastGoodOffset: toNonNegativeInt(scan?.lastGoodOffset),
    },
    sessions,
  };
}

function requireSessionKey(sessionKey: string): string {
  const normalized = sessionKey.trim();
  if (!normalized) {
    throw new Error("sessionKey is required");
  }
  return normalized;
}

async function writeJsonAtomic(path: string, content: string): Promise<void> {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // ignore cleanup errors
    }
    throw error;
  }
}

export function resolveWatermarksPath(customPath?: string): string {
  const preferred = customPath?.trim();
  if (preferred) {
    return preferred;
  }
  const fromEnv = process.env.ADJUTANT_WATERMARKS_PATH?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return DEFAULT_WATERMARKS_PATH;
}

export function createWatermarkStore(options: WatermarkStoreOptions = {}): WatermarkStore {
  const now = options.now ?? (() => new Date());
  const timelinePath = options.timelinePath?.trim() || DEFAULT_TIMELINE_PATH;
  const path = resolveWatermarksPath(options.path);
  let cache: WatermarksV1 | null = null;

  const load = async (): Promise<WatermarksV1> => {
    if (cache) {
      return clone(cache);
    }
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") {
        const empty = createDefaultWatermarks(timelinePath, now());
        cache = empty;
        return clone(empty);
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(raw);
      const normalized = normalizeWatermarks(parsed, { timelinePath, now: now() });
      cache = normalized;
      return clone(normalized);
    } catch (error) {
      options.onWarn?.("watermark-store-load-failed", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      const empty = createDefaultWatermarks(timelinePath, now());
      cache = empty;
      return clone(empty);
    }
  };

  const persist = async (next: WatermarksV1): Promise<WatermarksV1> => {
    const normalized = normalizeWatermarks(next, { timelinePath, now: now() });
    normalized.updatedAt = now().toISOString();
    await mkdir(dirname(path), { recursive: true });
    await writeJsonAtomic(path, `${JSON.stringify(normalized, null, 2)}\n`);
    cache = normalized;
    return clone(normalized);
  };

  const save = async (next: WatermarksV1): Promise<void> => {
    await persist(next);
  };

  const setScanOffsets = async (input: {
    lastScannedOffset: number;
    lastGoodOffset: number;
  }): Promise<WatermarksV1> => {
    const current = await load();
    current.scan.lastScannedOffset = toNonNegativeInt(input.lastScannedOffset);
    current.scan.lastGoodOffset = toNonNegativeInt(input.lastGoodOffset);
    return await persist(current);
  };

  const advanceHandled = async (
    sessionKey: string,
    input: { offset: number; ts?: string }
  ): Promise<WatermarksV1> => {
    const key = requireSessionKey(sessionKey);
    const current = await load();
    const entry = current.sessions[key] ?? { handled: {}, open: {} };
    entry.handled.lastHandledOffset = toNonNegativeInt(input.offset);
    entry.handled.lastHandledTs = isIsoString(input.ts) ? input.ts : entry.handled.lastHandledTs;
    current.sessions[key] = entry;
    return await persist(current);
  };

  const updateOpenPosts = async (
    sessionKey: string,
    input: { oldestOpenPostTs?: string; openPostCount?: number }
  ): Promise<WatermarksV1> => {
    const key = requireSessionKey(sessionKey);
    const current = await load();
    const entry = current.sessions[key] ?? { handled: {}, open: {} };
    const openPostCount = toNonNegativeInt(input.openPostCount, entry.open.openPostCount ?? 0);
    entry.open.openPostCount = openPostCount;
    if (openPostCount <= 0) {
      entry.open.oldestOpenPostTs = undefined;
    } else if (isIsoString(input.oldestOpenPostTs)) {
      entry.open.oldestOpenPostTs = input.oldestOpenPostTs;
    } else if (input.oldestOpenPostTs !== undefined) {
      entry.open.oldestOpenPostTs = undefined;
    }
    current.sessions[key] = entry;
    return await persist(current);
  };

  const pruneSessions = async (): Promise<WatermarksV1> => {
    const current = await load();
    const nextSessions: WatermarksV1["sessions"] = {};
    for (const [key, value] of Object.entries(current.sessions)) {
      const openPostCount = toNonNegativeInt(value.open.openPostCount, 0);
      const lastHandledOffset = value.handled.lastHandledOffset;
      const isPrunable =
        openPostCount === 0 &&
        typeof lastHandledOffset === "number" &&
        lastHandledOffset <= current.scan.lastScannedOffset;
      if (!isPrunable) {
        nextSessions[key] = value;
      }
    }
    current.sessions = nextSessions;
    return await persist(current);
  };

  const recoverIfTimelineTruncated = async (): Promise<{
    recovered: boolean;
    watermarks: WatermarksV1;
  }> => {
    const current = await load();
    let fileSize = 0;
    try {
      const info = await stat(current.scan.timelinePath || timelinePath);
      fileSize = toNonNegativeInt(info.size);
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code !== "ENOENT") {
        throw error;
      }
    }

    if (current.scan.lastScannedOffset <= fileSize) {
      return { recovered: false, watermarks: current };
    }

    current.scan.lastScannedOffset = 0;
    current.scan.lastGoodOffset = 0;
    current.sessions = {};
    const saved = await persist(current);
    return { recovered: true, watermarks: saved };
  };

  const applyTerminalRecord = async (input: {
    sessionKey: string;
    actionType: TimelineActionType;
    offset: number;
    ts?: string;
  }): Promise<WatermarksV1> => {
    if (input.actionType === "assistant_final") {
      return await advanceHandled(input.sessionKey, {
        offset: input.offset,
        ts: input.ts,
      });
    }
    return await load();
  };

  return {
    load,
    save,
    setScanOffsets,
    advanceHandled,
    updateOpenPosts,
    pruneSessions,
    recoverIfTimelineTruncated,
    applyTerminalRecord,
  };
}
