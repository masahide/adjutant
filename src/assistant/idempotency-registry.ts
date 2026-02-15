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
  const runId = `${sessionKey}:${idempotencyKey}`;
  const now = Date.now();
  const existing = store.get(runId);
  if (existing && now - existing.createdAt < ttlSec * 1000) {
    return { kind: "existing", runId, status: existing.status };
  }
  store.set(runId, { status: "in_flight", createdAt: now });
  return { kind: "new", runId };
}

export function updateStatus(runId: string, status: "ok" | "error"): void {
  const entry = store.get(runId);
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
