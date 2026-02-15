import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type SessionEntryRecord = Record<string, unknown> & {
  sessionId?: unknown;
  sessionFile?: unknown;
  updatedAt?: unknown;
  agent?: unknown;
  lastHeartbeatText?: unknown;
  lastHeartbeatSentAt?: unknown;
};

export type SessionEntryStore = Record<string, SessionEntryRecord>;

const DEFAULT_SESSION_ENTRIES_PATH = join(process.cwd(), "data", "_assistant", "sessions.json");

export function resolveSessionEntriesPath(customPath?: string): string {
  const preferred = customPath?.trim();
  if (preferred) {
    return preferred;
  }
  const fromEnv = process.env.ADJUTANT_SESSION_ENTRIES_PATH?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return DEFAULT_SESSION_ENTRIES_PATH;
}

export async function readSessionEntryStore(
  customPath?: string
): Promise<{ path: string; store: SessionEntryStore }> {
  const path = resolveSessionEntriesPath(customPath);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return { path, store: {} };
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      await backupBrokenStore(path, "invalid root type");
      return { path, store: {} };
    }
    return { path, store: parsed as SessionEntryStore };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "json parse failed";
    await backupBrokenStore(path, reason);
    return { path, store: {} };
  }
}

export async function writeSessionEntryStore(
  store: SessionEntryStore,
  customPath?: string
): Promise<string> {
  const path = resolveSessionEntriesPath(customPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2), "utf8");
  return path;
}

export function getSessionEntry(
  store: SessionEntryStore,
  sessionKey: string
): SessionEntryRecord | null {
  const key = sessionKey.trim();
  if (!key) {
    return null;
  }
  const entry = store[key];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  return entry;
}

export function upsertSessionEntry(
  store: SessionEntryStore,
  sessionKey: string
): SessionEntryRecord {
  const key = sessionKey.trim() || "main";
  const entry = getSessionEntry(store, key);
  if (entry) {
    return entry;
  }
  const created: SessionEntryRecord = {};
  store[key] = created;
  return created;
}

export function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

async function backupBrokenStore(path: string, reason: string): Promise<void> {
  const backupPath = `${path}.broken-${Date.now()}`;
  try {
    await rename(path, backupPath);
    console.warn(
      `[SessionEntryStore] sessions.json is broken (${reason}). moved to: ${backupPath}`
    );
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT") {
      console.warn("[SessionEntryStore] failed to backup broken sessions.json:", error);
    }
  }
}
