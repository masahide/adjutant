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
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
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

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function handlePostChatMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Request body must be a JSON object" }));
    return;
  }

  try {
    const result = ChatHandler.acceptMessage(
      parsed as { message: string; sessionKey: string; idempotencyKey: string }
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    if (err instanceof ChatHandler.ValidationError) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    } else {
      throw err;
    }
  }
}

async function handlePostChatAbort(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Request body must be a JSON object" }));
    return;
  }

  const p = parsed as { sessionKey?: string; runId?: string };
  if (!p.sessionKey) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "sessionKey is required" }));
    return;
  }

  const result = ChatHandler.abort({ sessionKey: p.sessionKey, runId: p.runId });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
}

function handleStreamRun(
  runId: string,
  res: ServerResponse,
  sseConnections: Set<ServerResponse>
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  sseConnections.add(res);

  const keepalive = setInterval(() => {
    res.write(": ping\n\n");
  }, KEEPALIVE_INTERVAL_MS);

  const { events, unsubscribe } = StreamEventBridge.subscribe(runId);

  const pump = async () => {
    try {
      for await (const event of events) {
        const data = JSON.stringify(event);
        res.write(`event: chat\ndata: ${data}\n\n`);
        if (event.state === "final" || event.state === "aborted" || event.state === "error") {
          break;
        }
      }
    } finally {
      clearInterval(keepalive);
      sseConnections.delete(res);
      res.end();
    }
  };

  res.on("close", () => {
    unsubscribe();
    clearInterval(keepalive);
    sseConnections.delete(res);
  });

  pump().catch((err) => {
    console.error("[ApiServer] SSE pump error:", err);
  });
}

async function handleGetChatHistory(sessionKey: string | null, res: ServerResponse): Promise<void> {
  if (!sessionKey) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "sessionKey is required" }));
    return;
  }

  try {
    const messages = await loadMessages({ sessionKey });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessionKey, sessionId: sessionKey, messages }));
  } catch {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessionKey, sessionId: sessionKey, messages: [] }));
  }
}

async function handlePostHeartbeatRun(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ApiServerConfig
): Promise<void> {
  if (!cfg.heartbeatProvider) {
    res.writeHead(501, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "HeartbeatRunner not configured" }));
    return;
  }

  const body = await readBody(req);
  let parsed: { reason?: string } = {};
  try {
    if (body.trim()) parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  try {
    const result = await cfg.heartbeatProvider.runOnce({ reason: parsed.reason });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ error: err instanceof Error ? err.message : "HeartbeatRunner failed" })
    );
  }
}

function handleEventsStream(
  res: ServerResponse,
  cfg: ApiServerConfig,
  sseConnections: Set<ServerResponse>
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  sseConnections.add(res);

  const keepalive = setInterval(() => {
    res.write(": ping\n\n");
  }, KEEPALIVE_INTERVAL_MS);

  let unsubHeartbeat: (() => void) | undefined;
  if (cfg.heartbeatProvider) {
    unsubHeartbeat = cfg.heartbeatProvider.onHeartbeatEvent((evt) => {
      res.write(`event: heartbeat\ndata: ${JSON.stringify(evt)}\n\n`);
    });
  }

  res.on("close", () => {
    clearInterval(keepalive);
    sseConnections.delete(res);
    unsubHeartbeat?.();
  });
}

function handleGetHeartbeatLast(res: ServerResponse, cfg: ApiServerConfig): void {
  if (!cfg.heartbeatProvider) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("null");
    return;
  }

  const last = cfg.heartbeatProvider.getLastHeartbeatEvent();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(last));
}
