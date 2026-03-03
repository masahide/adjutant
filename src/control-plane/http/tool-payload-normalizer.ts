const DEFAULT_TOOL_PAYLOAD_MAX_BYTES = 16 * 1024;

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function sanitizeMaxBytes(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_TOOL_PAYLOAD_MAX_BYTES;
  }
  const normalized = Math.floor(value);
  return normalized >= 128 ? normalized : 128;
}

function truncateUtf8Text(value: string, maxBytes: number): string {
  const normalizedMaxBytes = sanitizeMaxBytes(maxBytes);
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= normalizedMaxBytes) {
    return value;
  }

  const omittedBytes = buffer.byteLength - normalizedMaxBytes;
  const marker = `...[truncated ${omittedBytes} bytes]...`;
  const markerBuffer = Buffer.from(marker, "utf8");
  if (markerBuffer.byteLength >= normalizedMaxBytes) {
    return markerBuffer.subarray(0, normalizedMaxBytes).toString("utf8");
  }

  const remaining = normalizedMaxBytes - markerBuffer.byteLength;
  const headBytes = Math.floor(remaining / 2);
  const tailBytes = remaining - headBytes;

  const head = buffer.subarray(0, headBytes);
  const tail = tailBytes > 0 ? buffer.subarray(buffer.byteLength - tailBytes) : Buffer.alloc(0);

  return Buffer.concat([head, markerBuffer, tail]).toString("utf8");
}

function safeJsonStringify(value: unknown): string | undefined {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, current) => {
      if (typeof current === "bigint") {
        return `[bigint:${current.toString()}]`;
      }
      if (typeof current === "function") {
        return "[function]";
      }
      if (typeof current === "symbol") {
        return `[symbol:${current.description ?? ""}]`;
      }
      if (current instanceof Error) {
        return {
          name: current.name,
          message: current.message,
        };
      }
      if (typeof current === "object" && current !== null) {
        if (seen.has(current)) {
          return "[circular]";
        }
        seen.add(current);
      }
      return current;
    });
  } catch {
    return undefined;
  }
}

function toJsonValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function firstContentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }

  for (const entry of content) {
    const record = asRecord(entry);
    const payload = asRecord(record?.content);
    const text = asString(payload?.text);
    if (text !== undefined && text.trim().length > 0) {
      return text;
    }
  }

  return undefined;
}

export function normalizeToolPayload(
  value: unknown,
  maxBytes = DEFAULT_TOOL_PAYLOAD_MAX_BYTES
): unknown {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return truncateUtf8Text(value, maxBytes);
  }

  const serialized = safeJsonStringify(value);
  if (serialized === undefined) {
    return "[unserializable]";
  }

  if (Buffer.byteLength(serialized, "utf8") <= sanitizeMaxBytes(maxBytes)) {
    return toJsonValue(serialized);
  }

  return truncateUtf8Text(serialized, maxBytes);
}

export function extractToolError(update: Record<string, unknown>): string | undefined {
  const direct = asString(update.error);
  if (direct !== undefined && direct.trim().length > 0) {
    return direct;
  }

  return firstContentText(update.content);
}

export { DEFAULT_TOOL_PAYLOAD_MAX_BYTES };
