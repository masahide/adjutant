import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  WATERMARKS_SCHEMA_V1,
  type TimelineActionType,
  type WatermarksV1,
  validateWatermarksV1,
} from "./schema.js";

type WatermarkStoreOptions = {
  path: string;
  timelinePath: string;
  nowIso?: () => string;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toNonNegativeInt(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.floor(parsed));
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }
  return normalized;
}

function createDefaultWatermarks(): WatermarksV1 {
  return {
    schema: WATERMARKS_SCHEMA_V1,
    scan: {
      lastScannedOffset: 0,
      lastGoodOffset: 0,
    },
    sessions: {},
  };
}

function normalizeWatermarks(input: unknown): WatermarksV1 {
  if (!validateWatermarksV1(input)) {
    return createDefaultWatermarks();
  }
  const normalized: WatermarksV1 = {
    schema: WATERMARKS_SCHEMA_V1,
    scan: {
      lastScannedOffset: toNonNegativeInt(input.scan.lastScannedOffset),
      lastGoodOffset: toNonNegativeInt(input.scan.lastGoodOffset),
    },
    sessions: {},
  };
  for (const [sessionKey, value] of Object.entries(input.sessions)) {
    const key = normalizeString(sessionKey);
    if (key === undefined) {
      continue;
    }
    normalized.sessions[key] = {
      handled: {
        lastHandledOffset: toNonNegativeInt(value.handled.lastHandledOffset),
      },
      open: {
        openPostCount: toNonNegativeInt(value.open.openPostCount),
        oldestOpenAt: normalizeString(value.open.oldestOpenAt),
        oldestActor: normalizeString(value.open.oldestActor),
      },
    };
    if (normalized.sessions[key].open.openPostCount <= 0) {
      normalized.sessions[key].open.oldestOpenAt = undefined;
      normalized.sessions[key].open.oldestActor = undefined;
    }
  }
  return normalized;
}

function normalizeSessionKey(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("watermark operation requires sessionKey");
  }
  return normalized;
}

async function writeJsonAtomic(path: string, text: string): Promise<void> {
  const tempPath = `${path}.tmp-${Date.now()}-${process.pid}`;
  try {
    await writeFile(tempPath, text, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup error.
    }
    throw error;
  }
}

export class WatermarkStore {
  private readonly path: string;
  private readonly timelinePath: string;
  private readonly nowIso: () => string;
  private readonly onWarn: (message: string, meta?: Record<string, unknown>) => void;
  private cache: WatermarksV1 | null = null;

  constructor(options: WatermarkStoreOptions) {
    this.path = options.path;
    this.timelinePath = options.timelinePath;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.onWarn = options.onWarn ?? (() => {});
  }

  static fromStateDir(
    stateDir: string,
    options?: {
      onWarn?: (message: string, meta?: Record<string, unknown>) => void;
    }
  ): WatermarkStore {
    return new WatermarkStore({
      path: join(stateDir, "watermarks.json"),
      timelinePath: join(stateDir, "timeline.jsonl"),
      onWarn: options?.onWarn,
    });
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async load(): Promise<WatermarksV1> {
    if (this.cache !== null) {
      return clone(this.cache);
    }
    let raw = "";
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const empty = createDefaultWatermarks();
        this.cache = empty;
        return clone(empty);
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      const normalized = normalizeWatermarks(parsed);
      this.cache = normalized;
      return clone(normalized);
    } catch (error) {
      this.onWarn("watermarks.load_failed", {
        path: this.path,
        reason: error instanceof Error ? error.message : String(error),
      });
      const empty = createDefaultWatermarks();
      this.cache = empty;
      return clone(empty);
    }
  }

  async save(next: WatermarksV1): Promise<void> {
    await this.persist(next);
  }

  async setScanOffsets(input: {
    lastScannedOffset: number;
    lastGoodOffset: number;
  }): Promise<WatermarksV1> {
    const current = await this.load();
    current.scan.lastScannedOffset = toNonNegativeInt(input.lastScannedOffset);
    current.scan.lastGoodOffset = toNonNegativeInt(input.lastGoodOffset);
    return await this.persist(current);
  }

  async advanceHandled(
    sessionKey: string,
    input: {
      offset: number;
    }
  ): Promise<WatermarksV1> {
    const key = normalizeSessionKey(sessionKey);
    const current = await this.load();
    const existing = current.sessions[key] ?? {
      handled: { lastHandledOffset: 0 },
      open: { openPostCount: 0 },
    };
    existing.handled.lastHandledOffset = toNonNegativeInt(input.offset);
    current.sessions[key] = existing;
    return await this.persist(current);
  }

  async updateOpenPosts(
    sessionKey: string,
    input: {
      openPostCount?: number;
      oldestOpenAt?: string;
      oldestActor?: string;
    }
  ): Promise<WatermarksV1> {
    const key = normalizeSessionKey(sessionKey);
    const current = await this.load();
    const existing = current.sessions[key] ?? {
      handled: { lastHandledOffset: 0 },
      open: { openPostCount: 0 },
    };
    const openPostCount = toNonNegativeInt(input.openPostCount, existing.open.openPostCount);
    existing.open.openPostCount = openPostCount;
    existing.open.oldestOpenAt =
      openPostCount > 0 ? normalizeString(input.oldestOpenAt) : undefined;
    existing.open.oldestActor = openPostCount > 0 ? normalizeString(input.oldestActor) : undefined;
    current.sessions[key] = existing;
    return await this.persist(current);
  }

  async pruneSessions(): Promise<WatermarksV1> {
    const current = await this.load();
    const nextSessions: WatermarksV1["sessions"] = {};
    for (const [sessionKey, session] of Object.entries(current.sessions)) {
      const openPostCount = toNonNegativeInt(session.open.openPostCount);
      const lastHandledOffset = toNonNegativeInt(session.handled.lastHandledOffset);
      const isPrunable =
        openPostCount <= 0 && lastHandledOffset <= toNonNegativeInt(current.scan.lastScannedOffset);
      if (!isPrunable) {
        nextSessions[sessionKey] = session;
      }
    }
    current.sessions = nextSessions;
    return await this.persist(current);
  }

  async recoverIfTimelineTruncated(): Promise<{
    recovered: boolean;
    watermarks: WatermarksV1;
  }> {
    const current = await this.load();
    let fileSize = 0;
    try {
      const info = await stat(this.timelinePath);
      fileSize = toNonNegativeInt(info.size);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (current.scan.lastScannedOffset <= fileSize) {
      return {
        recovered: false,
        watermarks: current,
      };
    }

    current.scan.lastScannedOffset = 0;
    current.scan.lastGoodOffset = 0;
    current.sessions = {};
    const saved = await this.persist(current);
    return {
      recovered: true,
      watermarks: saved,
    };
  }

  async applyTerminalRecord(input: {
    sessionKey: string;
    actionType: TimelineActionType;
    offset: number;
  }): Promise<WatermarksV1> {
    if (input.actionType !== "assistant_final") {
      return await this.load();
    }
    return await this.advanceHandled(input.sessionKey, {
      offset: input.offset,
    });
  }

  private async persist(next: WatermarksV1): Promise<WatermarksV1> {
    const normalized = normalizeWatermarks(next);
    await mkdir(dirname(this.path), { recursive: true });
    await writeJsonAtomic(
      this.path,
      `${JSON.stringify(
        {
          ...normalized,
          updatedAt: this.nowIso(),
        },
        null,
        2
      )}\n`
    );
    this.cache = normalized;
    return clone(normalized);
  }
}
