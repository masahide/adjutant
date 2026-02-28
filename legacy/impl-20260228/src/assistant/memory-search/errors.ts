export type MemorySearchErrorCode =
  | "validation_error"
  | "index_unavailable"
  | "embedding_unavailable"
  | "permission_denied"
  | "tool_contract_error";

export class MemorySearchError extends Error {
  readonly code: MemorySearchErrorCode;
  readonly cause?: unknown;

  constructor(code: MemorySearchErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "MemorySearchError";
    this.code = code;
    this.cause = cause;
  }
}

function detectCodeFromMessage(message: string): MemorySearchErrorCode {
  const normalized = message.toLowerCase();
  if (normalized.includes("path required")) {
    return "permission_denied";
  }
  if (
    normalized.includes("sqlite-vec unavailable") ||
    normalized.includes("memory_search requires vector search") ||
    normalized.includes("index unavailable")
  ) {
    return "index_unavailable";
  }
  if (
    normalized.includes("embedding") ||
    normalized.includes("openai") ||
    normalized.includes("api key")
  ) {
    return "embedding_unavailable";
  }
  if (normalized.includes("required") || normalized.includes("invalid")) {
    return "validation_error";
  }
  return "tool_contract_error";
}

export function normalizeMemorySearchError(
  error: unknown,
  fallbackCode: MemorySearchErrorCode = "tool_contract_error"
): MemorySearchError {
  if (error instanceof MemorySearchError) {
    return error;
  }
  if (error instanceof Error) {
    const code = detectCodeFromMessage(error.message) ?? fallbackCode;
    return new MemorySearchError(code, error.message, error);
  }
  const message = String(error);
  const code = detectCodeFromMessage(message) ?? fallbackCode;
  return new MemorySearchError(code, message, error);
}
