export type ApiErrorCode =
  | "INVALID_JSON"
  | "INVALID_REQUEST"
  | "IDEMPOTENCY_PAYLOAD_MISMATCH"
  | "LAST_EVENT_ID_EXPIRED"
  | "INTERNAL_ERROR";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(params: {
    status: number;
    code: ApiErrorCode;
    message: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  }) {
    super(params.message);
    this.name = "ApiError";
    this.status = params.status;
    this.code = params.code;
    this.retryable = params.retryable ?? false;
    this.details = params.details;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
