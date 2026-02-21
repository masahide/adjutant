import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { StrictDedupEntry } from "./dedup-store.js";

type StoredIdempotencyEntry = StrictDedupEntry & {
  schema: "adjutant.idempotency.record.v1";
};

function isStoredIdempotencyEntry(value: unknown): value is StoredIdempotencyEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    entry.schema === "adjutant.idempotency.record.v1" &&
    typeof entry.storeKey === "string" &&
    typeof entry.sessionKey === "string" &&
    typeof entry.idempotencyKey === "string" &&
    typeof entry.runId === "string" &&
    typeof entry.fingerprint === "string" &&
    typeof entry.status === "string" &&
    typeof entry.createdAt === "number" &&
    typeof entry.updatedAt === "number" &&
    typeof entry.expiresAt === "number"
  );
}

export function appendIdempotencyEntry(filePath: string, entry: StrictDedupEntry): void {
  const record: StoredIdempotencyEntry = {
    schema: "adjutant.idempotency.record.v1",
    ...entry,
  };
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

export function loadIdempotencyEntries(
  filePath: string,
  opts: { strict?: boolean } = {}
): StrictDedupEntry[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const result: StrictDedupEntry[] = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isStoredIdempotencyEntry(parsed)) {
        continue;
      }
      result.push({
        storeKey: parsed.storeKey,
        sessionKey: parsed.sessionKey,
        idempotencyKey: parsed.idempotencyKey,
        runId: parsed.runId,
        fingerprint: parsed.fingerprint,
        status: parsed.status,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        expiresAt: parsed.expiresAt,
      });
    } catch {
      if (opts.strict) {
        throw new Error("idempotency store contains malformed jsonl line");
      }
      // 末尾破損は起動時 recovery で処理するためここでは無視
    }
  }
  return result;
}
