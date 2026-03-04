import { PROCESS_RPC_METHODS } from "../contracts/process-rpc/method-types.js";
import { validateDeliverEnqueueRequest } from "../contracts/process-rpc/rpc-types.js";
import { attachUtf8LineReader } from "../control-plane/supervisor/stdio-supervisor-utils.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  return fallback;
}

function parseInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

function writeEnvelope(envelope: unknown): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function writeError(id: string | number | null, code: number, message: string): void {
  writeEnvelope({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  });
}

function writeSuccess(id: string | number, result: Record<string, unknown>): void {
  writeEnvelope({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function parseJsonRpcRequest(line: string): JsonRpcRequest | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isObject(parsed) || parsed.jsonrpc !== "2.0") {
      return undefined;
    }
    if (!(typeof parsed.id === "string" || typeof parsed.id === "number")) {
      return undefined;
    }
    if (typeof parsed.method !== "string") {
      return undefined;
    }
    return parsed as unknown as JsonRpcRequest;
  } catch {
    return undefined;
  }
}

function handleDeliverEnqueue(request: JsonRpcRequest): void {
  const params = request.params;
  if (!validateDeliverEnqueueRequest(params)) {
    writeError(request.id, -32600, "INVALID_REQUEST");
    return;
  }

  const acceptedAt = new Date().toISOString();
  writeSuccess(request.id, {
    messageId: params.messageId,
    status: "accepted",
    acceptedAt,
  });

  const autoComplete = parseBoolean(process.env.ADJUTANT_DELIVER_SLACK_AUTO_COMPLETE, true);
  if (!autoComplete) {
    return;
  }
  const completionDelayMs = parseInteger(process.env.ADJUTANT_DELIVER_SLACK_COMPLETION_DELAY_MS, 5);
  const completionStatus = parseBoolean(process.env.ADJUTANT_DELIVER_SLACK_SIMULATE_FAILURE, false)
    ? "failed"
    : "completed";
  setTimeout(() => {
    writeEnvelope({
      jsonrpc: "2.0",
      method: PROCESS_RPC_METHODS.DELIVER_COMPLETED,
      params: {
        messageId: params.messageId,
        status: completionStatus,
        finishedAt: new Date().toISOString(),
        ...(completionStatus === "failed" ? { error: "deliver-slack simulated failure" } : {}),
      },
    });
  }, completionDelayMs);
}

function handleRequestLine(line: string): void {
  const request = parseJsonRpcRequest(line);
  if (request === undefined) {
    writeError(null, -32700, "PARSE_ERROR");
    return;
  }

  if (request.method === "initialize") {
    writeSuccess(request.id, {
      protocolVersion: 1,
      component: "deliver-slack",
    });
    return;
  }

  if (request.method === PROCESS_RPC_METHODS.DELIVER_ENQUEUE) {
    handleDeliverEnqueue(request);
    return;
  }

  writeError(request.id, -32601, "METHOD_NOT_FOUND");
}

export function startDeliverSlackStdioServer(): void {
  attachUtf8LineReader(process.stdin, (line) => {
    handleRequestLine(line);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startDeliverSlackStdioServer();
}
