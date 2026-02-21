export type DedupStatus = "in_flight" | "ok" | "error";

export type StrictDedupEntry = {
  storeKey: string;
  sessionKey: string;
  idempotencyKey: string;
  runId: string;
  fingerprint: string;
  status: DedupStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

export function evictExpired(entries: Map<string, StrictDedupEntry>, now: number): number {
  let removed = 0;
  for (const [storeKey, entry] of entries) {
    if (entry.expiresAt <= now) {
      entries.delete(storeKey);
      removed += 1;
    }
  }
  return removed;
}

export function evictOldest(entries: Map<string, StrictDedupEntry>, maxEntries: number): number {
  if (entries.size <= maxEntries) {
    return 0;
  }
  const sorted = Array.from(entries.values()).sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt - b.createdAt;
    }
    return a.storeKey.localeCompare(b.storeKey);
  });
  let removed = 0;
  for (const entry of sorted) {
    if (entries.size <= maxEntries) {
      break;
    }
    if (entries.delete(entry.storeKey)) {
      removed += 1;
    }
  }
  return removed;
}
