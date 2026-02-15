import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { HeartbeatEventPayload } from "./types.js";
import * as ChatHandler from "./chat-handler.js";
import * as StreamEventBridge from "./stream-event-bridge.js";
import { loadMessages } from "./index.js";

export type HeartbeatProvider = {
  onHeartbeatEvent: (listener: (evt: HeartbeatEventPayload) => void) => () => void;
  getLastHeartbeatEvent: () => HeartbeatEventPayload | null;
  runOnce: (opts?: { reason?: string }) => Promise<unknown>;
};

export type ApiServerConfig = {
  port: number;
  host: string;
  heartbeatProvider?: HeartbeatProvider;
};

const DEFAULT_CONFIG: ApiServerConfig = {
  port: 3100,
  host: "127.0.0.1",
};

const KEEPALIVE_INTERVAL_MS = 15_000;

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
        sendJson(res, 500, { error: "Internal Server Error" });
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
    sendJson(res, 400, { error: "Invalid JSON" });
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    sendJson(res, 400, { error: "Request body must be a JSON object" });
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

  // TODO: restrict CORS origin to Vite dev server / production domain
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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

  const streamMatch = path.match(/^\/api\/chat\/runs\/([^/]+)\/stream$/);
  if (method === "GET" && streamMatch && streamMatch[1]) {
    return handleStreamRun(decodeURIComponent(streamMatch[1]), res, sseConnections);
  }

  if (method === "GET" && path === "/api/chat/history") {
    const sessionKey = url.searchParams.get("sessionKey");
    return handleGetChatHistory(sessionKey, res);
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

  sendJson(res, 404, { error: "Not Found" });
}

// ── Route handlers ──

async function handlePostChatMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, res);
  if (!body) return;

  try {
    const result = ChatHandler.acceptMessage(
      body as unknown as { message: string; sessionKey: string; idempotencyKey: string }
    );
    sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof ChatHandler.ValidationError) {
      sendJson(res, 400, { error: err.message });
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

function handleStreamRun(
  runId: string,
  res: ServerResponse,
  sseConnections: Set<ServerResponse>
): void {
  const cleanupSse = startSseStream(res, sseConnections);
  const { events, unsubscribe } = StreamEventBridge.subscribe(runId);

  const pump = async () => {
    try {
      for await (const event of events) {
        res.write(`event: chat\ndata: ${JSON.stringify(event)}\n\n`);
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

async function handleGetChatHistory(sessionKey: string | null, res: ServerResponse): Promise<void> {
  if (!sessionKey) {
    sendJson(res, 400, { error: "sessionKey is required" });
    return;
  }

  try {
    const messages = await loadMessages({ sessionKey });
    sendJson(res, 200, { sessionKey, sessionId: sessionKey, messages });
  } catch {
    sendJson(res, 200, { sessionKey, sessionId: sessionKey, messages: [] });
  }
}

async function handlePostHeartbeatRun(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ApiServerConfig
): Promise<void> {
  if (!cfg.heartbeatProvider) {
    sendJson(res, 501, { error: "HeartbeatRunner not configured" });
    return;
  }

  const raw = await readBody(req);
  let parsed: { reason?: string } = {};
  try {
    if (raw.trim()) parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
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
