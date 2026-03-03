import { createHash } from "node:crypto";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeys(item as JsonValue));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const entries = Object.entries(value as Record<string, JsonValue>).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  const result: Record<string, JsonValue> = {};
  for (const [key, child] of entries) {
    result[key] = sortKeys(child);
  }
  return result;
}

export function computeJsonlChecksum(payload: Record<string, unknown>): string {
  const normalized = sortKeys(payload as JsonValue);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}

export function withJsonlChecksum<T extends Record<string, unknown>>(
  record: T
): T & { checksum: string } {
  const payload = { ...record };
  delete (payload as { checksum?: string }).checksum;
  const checksum = computeJsonlChecksum(payload);
  return { ...payload, checksum };
}
