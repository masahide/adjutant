export type CollectorErrorSummary = {
  name: string;
  message: string;
  stack?: string;
  cause?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  const record = asRecord(error);
  if (record !== null) {
    const message = record.message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }
  return "unknown error";
}

export function summarizeError(error: unknown): CollectorErrorSummary {
  if (error instanceof Error) {
    const anyError = error as Error & { cause?: unknown };
    return {
      name: error.name || "Error",
      message: toErrorMessage(error),
      stack: typeof error.stack === "string" ? error.stack : undefined,
      cause: anyError.cause === undefined ? undefined : toErrorMessage(anyError.cause),
    };
  }
  return {
    name: "UnknownError",
    message: toErrorMessage(error),
  };
}
