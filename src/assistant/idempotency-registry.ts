import type { DedupResult } from "./api-types.js";

type RunEntry = {
  status: "in_flight" | "ok" | "error";
  createdAt: number;
};

const store = new Map<string, RunEntry>();

export function getOrCreate(
  sessionKey: string,
  idempotencyKey: string,
  ttlSec: number = 300
): DedupResult {
  const storeKey = `${sessionKey}:${idempotencyKey}`;
  const runId = idempotencyKey;
  const now = Date.now();
  const existing = store.get(storeKey);
  if (existing && now - existing.createdAt < ttlSec * 1000) {
    return { kind: "existing", runId, storeKey, status: existing.status };
  }
  store.set(storeKey, { status: "in_flight", createdAt: now });
  return { kind: "new", runId, storeKey };
}

export function updateStatus(storeKey: string, status: "ok" | "error"): void {
  const entry = store.get(storeKey);
  if (entry) {
    entry.status = status;
  }
}

export function cleanup(now: number = Date.now(), ttlSec: number = 300): number {
  let removed = 0;
  for (const [key, entry] of store) {
    if (now - entry.createdAt >= ttlSec * 1000) {
      store.delete(key);
      removed++;
    }
  }
  return removed;
}

export function resetForTest(): void {
  store.clear();
}
