export type StructuredLogLevel = "debug" | "info" | "warn" | "error";

export interface StructuredLogInput {
  level?: StructuredLogLevel;
  event: string;
  message?: string;
  runId?: string | null;
  sessionKey?: string | null;
  toolCallId?: string | null;
  [key: string]: unknown;
}

export function writeStructuredLog(scope: string, input: StructuredLogInput): void {
  const {
    level = "info",
    event,
    message,
    runId = null,
    sessionKey = null,
    toolCallId = null,
    ...rest
  } = input;
  const payload = {
    ts: new Date().toISOString(),
    scope,
    level,
    event,
    message,
    runId,
    sessionKey,
    toolCallId,
    ...rest,
  };
  process.stderr.write(`[${scope}] ${JSON.stringify(payload)}\n`);
}
