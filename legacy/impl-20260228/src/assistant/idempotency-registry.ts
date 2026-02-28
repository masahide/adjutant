import type { DedupResult } from "./api-types.js";
import {
  evictExpired,
  evictOldest,
  type DedupStatus,
  type StrictDedupEntry,
} from "./dedup-store.js";
import { appendIdempotencyEntry, loadIdempotencyEntries } from "./idempotency-store.js";

type RegistryConfig = {
  now: () => number;
  storePath: string | null;
  maxEntries: number;
  storeFailureMode: "open" | "closed";
};

type ExistingResult = Extract<DedupResult, { kind: "existing" | "conflict" }>;

const DEFAULT_CONFIG: RegistryConfig = {
  now: () => Date.now(),
  storePath: null,
  maxEntries: 5000,
  storeFailureMode: "open",
};

let config: RegistryConfig = { ...DEFAULT_CONFIG };
const store = new Map<string, StrictDedupEntry>();

function createStoreKey(sessionKey: string, idempotencyKey: string): string {
  return `${sessionKey}:${idempotencyKey}`;
}

function runIdOf(idempotencyKey: string): string {
  return idempotencyKey;
}

function persist(entry: StrictDedupEntry): void {
  if (!config.storePath) {
    return;
  }
  appendIdempotencyEntry(config.storePath, entry);
}

function currentStatus(entry: StrictDedupEntry): ExistingResult["status"] {
  return entry.status;
}

function findExisting(storeKey: string, fingerprint: string, now: number): ExistingResult | null {
  const entry = store.get(storeKey);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= now) {
    store.delete(storeKey);
    return null;
  }
  if (entry.fingerprint !== fingerprint) {
    return {
      kind: "conflict",
      runId: entry.runId,
      storeKey,
      status: currentStatus(entry),
    };
  }
  return {
    kind: "existing",
    runId: entry.runId,
    storeKey,
    status: currentStatus(entry),
  };
}

export function configureRegistry(opts: {
  now?: () => number;
  storePath?: string | null;
  maxEntries?: number;
  storeFailureMode?: "open" | "closed";
}): void {
  config = {
    now: opts.now ?? DEFAULT_CONFIG.now,
    storePath:
      typeof opts.storePath === "string" && opts.storePath.trim().length > 0
        ? opts.storePath.trim()
        : null,
    maxEntries:
      Number.isFinite(opts.maxEntries) && (opts.maxEntries as number) > 0
        ? Math.max(100, Math.floor(opts.maxEntries as number))
        : DEFAULT_CONFIG.maxEntries,
    storeFailureMode: opts.storeFailureMode === "closed" ? "closed" : "open",
  };
}

export function loadFromStore(): number {
  if (!config.storePath) {
    return 0;
  }
  const now = config.now();
  let entries: StrictDedupEntry[] = [];
  try {
    entries = loadIdempotencyEntries(config.storePath, {
      strict: config.storeFailureMode === "closed",
    });
  } catch {
    if (config.storeFailureMode === "closed") {
      throw new Error("idempotency store failed to load");
    }
    return 0;
  }
  let restored = 0;
  for (const entry of entries) {
    if (entry.expiresAt <= now) {
      continue;
    }
    const existing = store.get(entry.storeKey);
    if (!existing || existing.updatedAt <= entry.updatedAt) {
      store.set(entry.storeKey, entry);
      restored += 1;
    }
  }
  evictOldest(store, config.maxEntries);
  return restored;
}

export function getOrCreate(
  sessionKey: string,
  idempotencyKey: string,
  fingerprint: string,
  ttlSec: number = 300
): DedupResult {
  const now = config.now();
  evictExpired(store, now);
  const storeKey = createStoreKey(sessionKey, idempotencyKey);
  const existing = findExisting(storeKey, fingerprint, now);
  if (existing) {
    return existing;
  }

  const createdAt = now;
  const entry: StrictDedupEntry = {
    storeKey,
    sessionKey,
    idempotencyKey,
    runId: runIdOf(idempotencyKey),
    fingerprint,
    status: "in_flight",
    createdAt,
    updatedAt: createdAt,
    expiresAt: createdAt + Math.max(1, Math.floor(ttlSec)) * 1000,
  };
  store.set(storeKey, entry);
  evictOldest(store, config.maxEntries);
  persist(entry);
  return { kind: "new", runId: entry.runId, storeKey };
}

export function updateStatus(storeKey: string, status: DedupStatus): void {
  const entry = store.get(storeKey);
  if (!entry) {
    return;
  }
  entry.status = status;
  entry.updatedAt = config.now();
  persist(entry);
}

export function cleanup(now: number = config.now(), _ttlSec: number = 300): number {
  return evictExpired(store, now);
}

export function resetForTest(): void {
  config = { ...DEFAULT_CONFIG };
  store.clear();
}
