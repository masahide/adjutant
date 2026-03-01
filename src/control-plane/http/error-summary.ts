export const CONTROL_PLANE_ERROR_CODES = [
  "INVALID_REQUEST",
  "UNSUPPORTED_CAPABILITY",
  "ACP_PROTOCOL_ERROR",
  "JOURNAL_APPEND_FAILED",
  "WORKER_TIMEOUT",
  "WORKER_CRASHED",
  "INVALID_RECORD",
  "DOWNSTREAM_ERROR",
] as const;

export type ControlPlaneErrorCode = (typeof CONTROL_PLANE_ERROR_CODES)[number];

export interface ErrorSummary {
  errorCode: ControlPlaneErrorCode;
  errorMessage: string;
}

const ERROR_PREFIX_PATTERN = /^([A-Z_]+)(?::\s*(.*))?$/s;
const KNOWN_ERROR_CODES = new Set<string>(CONTROL_PLANE_ERROR_CODES);
const WORKER_CRASH_ALIASES = new Set<string>([
  "WORKER_IO_ERROR",
  "WORKER_NOT_READY",
  "WORKER_NOT_RUNNING",
  "WORKER_STOPPED",
]);

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeCode(code: string | undefined): ControlPlaneErrorCode | undefined {
  if (code === undefined) {
    return undefined;
  }
  if (WORKER_CRASH_ALIASES.has(code)) {
    return "WORKER_CRASHED";
  }
  if (KNOWN_ERROR_CODES.has(code)) {
    return code as ControlPlaneErrorCode;
  }
  return undefined;
}

export function toErrorSummary(error: unknown): ErrorSummary {
  const rawMessage = toMessage(error);
  const matched = ERROR_PREFIX_PATTERN.exec(rawMessage);
  if (matched === null) {
    return {
      errorCode: "DOWNSTREAM_ERROR",
      errorMessage: rawMessage,
    };
  }

  const normalizedCode = normalizeCode(matched[1]);
  if (normalizedCode === undefined) {
    return {
      errorCode: "DOWNSTREAM_ERROR",
      errorMessage: rawMessage,
    };
  }

  return {
    errorCode: normalizedCode,
    errorMessage: matched[2] && matched[2].length > 0 ? matched[2] : rawMessage,
  };
}

export function toHttpStatusCode(summary: ErrorSummary): number {
  switch (summary.errorCode) {
    case "INVALID_REQUEST":
      return 400;
    case "UNSUPPORTED_CAPABILITY":
    case "INVALID_RECORD":
      return 422;
    case "WORKER_CRASHED":
      return 503;
    case "WORKER_TIMEOUT":
      return 504;
    case "ACP_PROTOCOL_ERROR":
      return 502;
    case "JOURNAL_APPEND_FAILED":
    case "DOWNSTREAM_ERROR":
    default:
      return 500;
  }
}
