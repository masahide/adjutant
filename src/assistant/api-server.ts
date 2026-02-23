import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { HeartbeatEventPayload, HeartbeatRunRecord } from "./types.js";
import * as ChatHandler from "./chat-handler.js";
import * as StreamEventBridge from "./stream-event-bridge.js";
import { loadMessages } from "./index.js";
import { ApiError, isApiError, type ApiErrorCode } from "./errors.js";
import { readRunAudit, resolveAgentAuditLogPath } from "./audit-reader.js";
import { resolveSessionKeyByRunId } from "./run-index-repository.js";
import { readRunSummaryFromTranscript } from "./transcript-reader.js";
import { resolveAdjutantStateDir } from "./session-paths.js";

export type HeartbeatProvider = {
  onHeartbeatEvent: (listener: (evt: HeartbeatEventPayload) => void) => () => void;
  getLastHeartbeatEvent: () => HeartbeatEventPayload | null;
  runOnce: (opts?: { reason?: string }) => Promise<unknown>;
};

export type ApiServerConfig = {
  port: number;
  host: string;
  corsOrigin: string;
  heartbeatProvider?: HeartbeatProvider;
  sessionEntriesPath?: string;
  agentAuditLogPath?: string;
  heartbeatRunsPath?: string;
  runIndexPath?: string;
};

const DEFAULT_CONFIG: ApiServerConfig = {
  port: 3100,
  host: "127.0.0.1",
  corsOrigin: "*",
};

const KEEPALIVE_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_HISTORY_LIMIT = 20;
const MAX_HEARTBEAT_HISTORY_LIMIT = 100;
const HEARTBEAT_RUNS_DEFAULT_RELATIVE_PATH = "heartbeat-runs.jsonl";

type HeartbeatHistoryRecord = {
  record: HeartbeatRunRecord;
  runAtMs: number;
  fileOffset: number;
  cursor: string;
};

export function createApiServer(userConfig?: Partial<ApiServerConfig>): {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  server: Server;
} {
  const cfg = { ...DEFAULT_CONFIG, ...userConfig };
  const sseConnections = new Set<ServerResponse>();

  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, cfg, sseConnections);
    } catch (err) {
      if (!res.headersSent) {
        if (isApiError(err)) {
          sendApiError(res, err);
        } else {
          sendError(res, 500, "INTERNAL_ERROR", "Internal Server Error");
        }
      }
      console.error("[ApiServer] Unhandled error:", err);
    }
  });

  const start = (): Promise<void> =>
    new Promise((resolve) => {
      server.listen(cfg.port, cfg.host, () => {
        console.log(`[ApiServer] Listening on http://${cfg.host}:${cfg.port}`);
        resolve();
      });
    });

  const stop = (): Promise<void> =>
    new Promise((resolve, reject) => {
      for (const conn of sseConnections) {
        conn.end();
      }
      sseConnections.clear();
      server.close((err) => (err ? reject(err) : resolve()));
    });

  return { start, stop, server };
}

// ── HTTP helpers ──

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendError(
  res: ServerResponse,
  status: number,
  code: ApiErrorCode,
  message: string,
  retryable: boolean = false,
  details?: Record<string, unknown>
): void {
  sendJson(res, status, {
    error: message,
    code,
    retryable,
    ...(details ? { details } : {}),
  });
}

function sendApiError(res: ServerResponse, error: ApiError): void {
  sendError(res, error.status, error.code, error.message, error.retryable, error.details);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse
): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendError(res, 400, "INVALID_JSON", "Invalid JSON");
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    sendError(res, 400, "INVALID_REQUEST", "Request body must be a JSON object");
    return null;
  }
  return parsed as Record<string, unknown>;
}

function startSseStream(res: ServerResponse, sseConnections: Set<ServerResponse>): () => void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  sseConnections.add(res);
  const keepalive = setInterval(() => res.write(": ping\n\n"), KEEPALIVE_INTERVAL_MS);
  return () => {
    clearInterval(keepalive);
    sseConnections.delete(res);
  };
}

// ── Router ──

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ApiServerConfig,
  sseConnections: Set<ServerResponse>
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const method = req.method ?? "GET";
  const path = url.pathname;

  const corsOrigin = cfg.corsOrigin.trim() || "*";
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Last-Event-ID, Idempotency-Key");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (method === "POST" && path === "/api/chat/messages") {
    return handlePostChatMessages(req, res);
  }
  if (method === "POST" && path === "/api/chat/abort") {
    return handlePostChatAbort(req, res);
  }

  // Keep explicit suffix routes before generic run stream matching.
  const runAuditMatch = path.match(/^\/api\/chat\/runs\/([^/]+)\/audit$/);
  if (method === "GET" && runAuditMatch && runAuditMatch[1]) {
    return handleGetRunAudit(decodeURIComponent(runAuditMatch[1]), res, cfg);
  }

  const streamMatch = path.match(/^\/api\/chat\/runs\/([^/]+)\/stream$/);
  if (method === "GET" && streamMatch && streamMatch[1]) {
    return handleStreamRun(req, decodeURIComponent(streamMatch[1]), res, sseConnections);
  }

  if (method === "GET" && path === "/api/chat/history") {
    const sessionKey = url.searchParams.get("sessionKey");
    return handleGetChatHistory(sessionKey, res, cfg);
  }

  if (method === "POST" && path === "/api/heartbeat/run") {
    return handlePostHeartbeatRun(req, res, cfg);
  }
  if (method === "GET" && path === "/api/events/stream") {
    return handleEventsStream(res, cfg, sseConnections);
  }
  if (method === "GET" && path === "/api/heartbeat/last") {
    return handleGetHeartbeatLast(res, cfg);
  }
  if (method === "GET" && path === "/api/heartbeat/history") {
    const limit = parseHeartbeatHistoryLimit(url.searchParams.get("limit"));
    const cursor = parseHeartbeatCursor(url.searchParams.get("cursor"));
    return handleGetHeartbeatHistory(res, cfg, { limit, cursor });
  }

  sendJson(res, 404, { error: "Not Found" });
}

// ── Route handlers ──

async function handlePostChatMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, res);
  if (!body) return;

  try {
    const result = ChatHandler.acceptMessage(resolveChatRequest(req, body));
    sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof ChatHandler.ValidationError) {
      sendError(res, 400, "INVALID_REQUEST", err.message);
    } else if (err instanceof ChatHandler.IdempotencyPayloadMismatchError) {
      sendError(res, 409, "IDEMPOTENCY_PAYLOAD_MISMATCH", err.message);
    } else if (isApiError(err)) {
      sendApiError(res, err);
    } else {
      throw err;
    }
  }
}

async function handlePostChatAbort(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, res);
  if (!body) return;

  const p = body as unknown as { sessionKey?: string; runId?: string };
  if (!p.sessionKey) {
    sendJson(res, 400, { error: "sessionKey is required" });
    return;
  }

  const result = ChatHandler.abort({ sessionKey: p.sessionKey, runId: p.runId });
  sendJson(res, 200, result);
}

function parseLastEventId(value: string): { runId: string; seq: number } | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const idx = trimmed.lastIndexOf(":");
  if (idx <= 0 || idx === trimmed.length - 1) {
    return null;
  }
  const runId = trimmed.slice(0, idx);
  const seqRaw = trimmed.slice(idx + 1);
  const seq = Number.parseInt(seqRaw, 10);
  if (!Number.isFinite(seq) || seq < 0) {
    return null;
  }
  return { runId, seq };
}

function readHeader(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw[0] ?? null;
  }
  return typeof raw === "string" ? raw : null;
}

function takeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function takeOrigin(value: unknown): "user" | "pipeline" | "system" | null {
  if (value === "user" || value === "pipeline" || value === "system") {
    return value;
  }
  return null;
}

function resolveAuditLogPath(cfg: ApiServerConfig): string {
  if (cfg.agentAuditLogPath?.trim()) {
    return resolve(cfg.agentAuditLogPath.trim());
  }
  return resolveAgentAuditLogPath();
}

function resolveHeartbeatRunsPath(cfg: ApiServerConfig): string {
  if (cfg.heartbeatRunsPath?.trim()) {
    return resolve(cfg.heartbeatRunsPath.trim());
  }
  const fromEnv = process.env.ADJUTANT_HEARTBEAT_RUNS_LOG_PATH?.trim();
  if (fromEnv) {
    return resolve(fromEnv);
  }
  return join(resolveAdjutantStateDir(), HEARTBEAT_RUNS_DEFAULT_RELATIVE_PATH);
}

function parseHeartbeatHistoryLimit(raw: string | null): number {
  if (!raw) {
    return DEFAULT_HEARTBEAT_HISTORY_LIMIT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_HEARTBEAT_HISTORY_LIMIT;
  }
  return Math.min(MAX_HEARTBEAT_HISTORY_LIMIT, Math.max(1, Math.floor(parsed)));
}

function parseHeartbeatCursor(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  const cursor = raw.trim();
  return cursor.length > 0 ? cursor : null;
}

function buildHeartbeatCursor(runAt: string, fileOffset: number): string {
  return `${runAt}:${String(fileOffset)}`;
}

function parseHeartbeatRunRecord(rawLine: string, lineNo: number): HeartbeatRunRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    console.warn("[ApiServer] invalid heartbeat history line skipped", {
      reason: "json-parse-failed",
      lineNo,
    });
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn("[ApiServer] invalid heartbeat history line skipped", {
      reason: "not-object",
      lineNo,
    });
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.runAt !== "string" || !record.runAt.trim()) {
    console.warn("[ApiServer] invalid heartbeat history line skipped", {
      reason: "missing-runAt",
      lineNo,
    });
    return null;
  }
  if (!record.result || typeof record.result !== "object" || Array.isArray(record.result)) {
    console.warn("[ApiServer] invalid heartbeat history line skipped", {
      reason: "missing-result",
      lineNo,
    });
    return null;
  }

  return record as unknown as HeartbeatRunRecord;
}

async function loadHeartbeatHistoryRecords(path: string): Promise<HeartbeatHistoryRecord[]> {
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const records: HeartbeatHistoryRecord[] = [];
  let cursor = 0;
  let lineNo = 1;
  while (cursor < raw.length) {
    const newlineIndex = raw.indexOf(0x0a, cursor);
    const endIndex = newlineIndex === -1 ? raw.length : newlineIndex;
    const lineBuffer = raw.subarray(cursor, endIndex);
    const line = lineBuffer.toString("utf8");
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      const record = parseHeartbeatRunRecord(trimmed, lineNo);
      if (record) {
        const parsedRunAt = Date.parse(record.runAt);
        const runAtMs = Number.isFinite(parsedRunAt) ? parsedRunAt : 0;
        records.push({
          record,
          runAtMs,
          fileOffset: cursor,
          cursor: buildHeartbeatCursor(record.runAt, cursor),
        });
      }
    }
    lineNo += 1;
    cursor = newlineIndex === -1 ? raw.length : newlineIndex + 1;
  }

  records.sort((a, b) => {
    if (a.runAtMs !== b.runAtMs) {
      return b.runAtMs - a.runAtMs;
    }
    return b.fileOffset - a.fileOffset;
  });
  return records;
}

function resolveChatRequest(
  req: IncomingMessage,
  body: Record<string, unknown>
): {
  message: string;
  sessionKey: string;
  idempotencyKey: string;
  origin?: "user" | "pipeline" | "system";
  clientMessageId?: string;
} {
  const message = takeNonEmptyString(body.message);
  const sessionKey = takeNonEmptyString(body.sessionKey);
  const headerKey = takeNonEmptyString(readHeader(req, "idempotency-key"));
  const clientMessageId = takeNonEmptyString(body.clientMessageId);
  const bodyIdempotencyKey = takeNonEmptyString(body.idempotencyKey);
  const effectiveIdempotencyKey = headerKey ?? clientMessageId ?? bodyIdempotencyKey;
  const origin = takeOrigin(body.origin);

  if (!message) {
    throw new ChatHandler.ValidationError("message is required");
  }
  if (!sessionKey) {
    throw new ChatHandler.ValidationError("sessionKey is required");
  }
  if (!effectiveIdempotencyKey) {
    throw new ChatHandler.ValidationError(
      "idempotency key is required via Idempotency-Key, clientMessageId, or idempotencyKey"
    );
  }

  return {
    message,
    sessionKey,
    idempotencyKey: effectiveIdempotencyKey,
    ...(origin ? { origin } : {}),
    ...(clientMessageId ? { clientMessageId } : {}),
  };
}

function handleStreamRun(
  req: IncomingMessage,
  runId: string,
  res: ServerResponse,
  sseConnections: Set<ServerResponse>
): void {
  const headerValue = readHeader(req, "last-event-id");
  const parsedLastEventId = headerValue ? parseLastEventId(headerValue) : null;
  if (headerValue && !parsedLastEventId) {
    sendError(res, 400, "INVALID_REQUEST", "Last-Event-ID must be formatted as <runId>:<seq>");
    return;
  }
  if (parsedLastEventId && parsedLastEventId.runId !== runId) {
    sendError(res, 400, "INVALID_REQUEST", "Last-Event-ID runId mismatch");
    return;
  }

  const { events, unsubscribe, replay } = StreamEventBridge.subscribe(runId, {
    afterSeq: parsedLastEventId?.seq,
  });
  if (replay.status === "expired") {
    sendError(
      res,
      409,
      "LAST_EVENT_ID_EXPIRED",
      "SSE replay buffer no longer has requested events",
      false,
      {
        minAvailableSeq: replay.minAvailableSeq,
        maxAvailableSeq: replay.maxAvailableSeq,
      }
    );
    return;
  }

  const cleanupSse = startSseStream(res, sseConnections);

  const pump = async () => {
    try {
      for await (const event of events) {
        res.write(
          `id: ${event.runId}:${event.seq}\nevent: chat\ndata: ${JSON.stringify(event)}\n\n`
        );
        if (event.state === "final" || event.state === "aborted" || event.state === "error") {
          break;
        }
      }
    } finally {
      cleanupSse();
      res.end();
    }
  };

  res.on("close", () => {
    unsubscribe();
    cleanupSse();
  });

  pump().catch((err) => {
    console.error("[ApiServer] SSE pump error:", err);
  });
}

async function handleGetChatHistory(
  sessionKey: string | null,
  res: ServerResponse,
  cfg: ApiServerConfig
): Promise<void> {
  if (!sessionKey) {
    sendError(res, 400, "INVALID_REQUEST", "sessionKey is required");
    return;
  }

  try {
    const messages = await loadMessages({
      sessionKey,
      sessionEntriesPath: cfg.sessionEntriesPath,
      auditLogPath: resolveAuditLogPath(cfg),
    });
    sendJson(res, 200, { sessionKey, sessionId: sessionKey, messages });
  } catch {
    sendJson(res, 200, { sessionKey, sessionId: sessionKey, messages: [] });
  }
}

async function handleGetRunAudit(
  runId: string,
  res: ServerResponse,
  cfg: ApiServerConfig
): Promise<void> {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    sendError(res, 400, "INVALID_REQUEST", "runId is required");
    return;
  }

  try {
    const sessionKey = await resolveSessionKeyByRunId(normalizedRunId, {
      path: cfg.runIndexPath,
    });
    if (sessionKey) {
      const summary = await readRunSummaryFromTranscript({
        sessionKey,
        runId: normalizedRunId,
        sessionEntriesPath: cfg.sessionEntriesPath,
      });
      if (summary) {
        sendJson(res, 200, summary);
        return;
      }
    }

    const response = await readRunAudit(normalizedRunId, {
      auditLogPath: resolveAuditLogPath(cfg),
    });
    sendJson(res, 200, response);
  } catch (error) {
    console.warn("[ApiServer] failed to load run audit; returning empty response", {
      runId: normalizedRunId,
      reason: error instanceof Error ? error.message : String(error),
    });
    sendJson(res, 200, { runId: normalizedRunId, runEnded: false, tools: [] });
  }
}

async function handleGetHeartbeatHistory(
  res: ServerResponse,
  cfg: ApiServerConfig,
  opts: { limit: number; cursor: string | null }
): Promise<void> {
  try {
    const records = await loadHeartbeatHistoryRecords(resolveHeartbeatRunsPath(cfg));
    let startIndex = 0;
    if (opts.cursor !== null) {
      const cursorIndex = records.findIndex((entry) => entry.cursor === opts.cursor);
      if (cursorIndex < 0) {
        sendError(res, 400, "INVALID_REQUEST", "Invalid cursor");
        return;
      }
      startIndex = cursorIndex + 1;
    }
    const page = records.slice(startIndex, startIndex + opts.limit);
    const hasMore = startIndex + page.length < records.length;
    const nextCursor = hasMore ? (page[page.length - 1]?.cursor ?? null) : null;
    sendJson(res, 200, {
      records: page.map((entry) => entry.record),
      hasMore,
      nextCursor,
    });
  } catch (error) {
    console.warn("[ApiServer] failed to load heartbeat history; returning empty response", {
      reason: error instanceof Error ? error.message : String(error),
    });
    sendJson(res, 200, {
      records: [],
      hasMore: false,
      nextCursor: null,
    });
  }
}

async function handlePostHeartbeatRun(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ApiServerConfig
): Promise<void> {
  if (!cfg.heartbeatProvider) {
    sendError(res, 501, "INVALID_REQUEST", "HeartbeatRunner not configured");
    return;
  }

  const raw = await readBody(req);
  let parsed: { reason?: string } = {};
  try {
    if (raw.trim()) parsed = JSON.parse(raw);
  } catch {
    sendError(res, 400, "INVALID_JSON", "Invalid JSON");
    return;
  }

  try {
    const result = await cfg.heartbeatProvider.runOnce({ reason: parsed.reason });
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : "HeartbeatRunner failed",
    });
  }
}

function handleEventsStream(
  res: ServerResponse,
  cfg: ApiServerConfig,
  sseConnections: Set<ServerResponse>
): void {
  const cleanupSse = startSseStream(res, sseConnections);

  let unsubHeartbeat: (() => void) | undefined;
  if (cfg.heartbeatProvider) {
    unsubHeartbeat = cfg.heartbeatProvider.onHeartbeatEvent((evt) => {
      res.write(`event: heartbeat\ndata: ${JSON.stringify(evt)}\n\n`);
    });
  }

  res.on("close", () => {
    cleanupSse();
    unsubHeartbeat?.();
  });
}

function handleGetHeartbeatLast(res: ServerResponse, cfg: ApiServerConfig): void {
  if (!cfg.heartbeatProvider) {
    sendJson(res, 200, null);
    return;
  }

  const last = cfg.heartbeatProvider.getLastHeartbeatEvent();
  sendJson(res, 200, last);
}
