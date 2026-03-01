import type { IncomingMessage, ServerResponse } from "node:http";

import type { PermissionGateway } from "../acp/permission-gateway.js";
import type { WorkerSupervisor } from "../acp/worker-supervisor.js";
import type {
  AcceptedResponse,
  CommandRequest,
  CreateThreadRequest,
  CreateThreadResponse,
  GetChatHistoryResponse,
  GetThreadResponse,
  ListThreadsResponse,
  PostPermissionResolveRequest,
  PostPermissionResolveResponse,
  PostChatAbortRequest,
  PostChatMessageRequest,
  PostChatMessageResponse,
  SnapshotResponse,
  ThreadSnapshotResponse,
  UpdateThreadRequest,
  UpdateThreadResponse,
} from "../contracts/http-api.js";
import { toErrorSummary, toHttpStatusCode } from "./error-summary.js";
import type { RunLifecycle } from "./run-lifecycle.js";
import type { SseHub } from "./sse-hub.js";
import type { RunEventBuffer } from "./run-event-buffer.js";
import { mapAbortToChatStreamEvent } from "./chat-stream-event-mapper.js";
import type { ChatHistoryStore } from "./chat-history-store.js";
import type { ThreadRepository } from "./thread-repository.js";

export interface SubmitPromptResult {
  accepted: AcceptedResponse;
  sessionId: string;
  idempotency: "miss" | "duplicate";
}

export interface SubmitPromptInput {
  sessionKey: string;
  message: string;
  idempotencyKey?: string;
}

interface ControlPlaneRouterDeps {
  sseHub: SseHub;
  renderRootPage: () => string;
  buildSnapshot: () => SnapshotResponse;
  submitPrompt: (input: SubmitPromptInput) => Promise<SubmitPromptResult>;
  readRunAudit: (runId: string) => Promise<unknown>;
  runLifecycle: RunLifecycle;
  runEventBuffer: RunEventBuffer;
  chatHistoryStore: ChatHistoryStore;
  threadRepository: ThreadRepository;
  buildThreadSnapshot: (threadId: string) => ThreadSnapshotResponse | undefined;
  supervisor: WorkerSupervisor;
  permissionGateway: PermissionGateway;
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (body.length === 0) {
    throw new Error("INVALID_REQUEST: empty body");
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error("INVALID_REQUEST: malformed json body");
  }
}

async function readJsonBodyOptional<T>(req: IncomingMessage): Promise<T | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (body.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error("INVALID_REQUEST: malformed json body");
  }
}

function isCommandRequest(value: unknown): value is CommandRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionKey === "string" &&
    record.sessionKey.trim().length > 0 &&
    typeof record.message === "string"
  );
}

function isPostChatMessageRequest(value: unknown): value is PostChatMessageRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionKey === "string" &&
    record.sessionKey.trim().length > 0 &&
    typeof record.message === "string" &&
    record.message.trim().length > 0 &&
    typeof record.idempotencyKey === "string" &&
    record.idempotencyKey.trim().length > 0
  );
}

function isPostChatAbortRequest(value: unknown): value is PostChatAbortRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionKey === "string" &&
    record.sessionKey.trim().length > 0 &&
    (record.runId === undefined || typeof record.runId === "string")
  );
}

function isCreateThreadRequest(value: unknown): value is CreateThreadRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "title")) {
    return false;
  }
  return record.title === undefined || typeof record.title === "string";
}

function isUpdateThreadRequest(value: unknown): value is UpdateThreadRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) {
    return false;
  }
  if (keys.some((key) => key !== "title" && key !== "archived")) {
    return false;
  }
  if (record.title !== undefined && typeof record.title !== "string") {
    return false;
  }
  if (record.archived !== undefined && typeof record.archived !== "boolean") {
    return false;
  }
  return true;
}

function isPostPermissionResolveRequest(value: unknown): value is PostPermissionResolveRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.requestId === "string" &&
    record.requestId.trim().length > 0 &&
    (record.outcome === "allow" || record.outcome === "deny")
  );
}

function normalizeIdempotencyKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toQueryValue(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function writeSse(res: ServerResponse, event: string, payload: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function setupSseHeaders(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
}

function findLatestActiveRunIdBySessionKey(
  runLifecycle: RunLifecycle,
  sessionKey: string
): string | undefined {
  let candidate: { runId: string; acceptedAt: string } | undefined;
  for (const run of runLifecycle.runs().values()) {
    if (run.sessionKey !== sessionKey) {
      continue;
    }
    if (run.status !== "accepted" && run.status !== "running") {
      continue;
    }
    if (candidate === undefined || run.acceptedAt > candidate.acceptedAt) {
      candidate = { runId: run.runId, acceptedAt: run.acceptedAt };
    }
  }
  return candidate?.runId;
}

function isActiveRunStatus(status: string): boolean {
  return status === "accepted" || status === "running";
}

export function createControlPlaneRequestHandler(deps: ControlPlaneRouterDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";
    const url = new URL(rawUrl, "http://127.0.0.1");

    if (method === "GET" && url.pathname === "/api/events/stream") {
      deps.sseHub.addClient(req, res);
      return;
    }

    if (method === "GET" && url.pathname === "/api/snapshot") {
      writeJson(res, 200, deps.buildSnapshot());
      return;
    }

    if (method === "POST" && url.pathname === "/api/permissions/resolve") {
      try {
        const payload = await readJsonBody<unknown>(req);
        if (!isPostPermissionResolveRequest(payload)) {
          writeJson(res, 400, {
            code: "INVALID_REQUEST",
            message: "requestId/outcome(allow|deny) are required",
          });
          return;
        }
        const resolved = deps.permissionGateway.resolvePermission(
          payload.requestId.trim(),
          payload.outcome
        );
        if (!resolved) {
          writeJson(res, 404, {
            code: "NOT_FOUND",
            message: `unknown permission requestId: ${payload.requestId}`,
          });
          return;
        }
        const response: PostPermissionResolveResponse = {};
        writeJson(res, 200, response);
      } catch (error) {
        const summary = toErrorSummary(error);
        writeJson(res, toHttpStatusCode(summary), {
          code: summary.errorCode,
          message: summary.errorMessage,
        });
      }
      return;
    }

    if (method === "GET" && url.pathname === "/api/threads") {
      const response: ListThreadsResponse = deps.threadRepository.list();
      writeJson(res, 200, response);
      return;
    }

    if (method === "POST" && url.pathname === "/api/threads") {
      try {
        const payload = await readJsonBodyOptional<unknown>(req);
        if (payload !== undefined && !isCreateThreadRequest(payload)) {
          writeJson(res, 400, {
            code: "INVALID_REQUEST",
            message: "title is optional and must be string",
          });
          return;
        }
        const request = payload as CreateThreadRequest | undefined;
        const title = request?.title;
        const created = await deps.threadRepository.create({ title });
        const response: CreateThreadResponse = created;
        writeJson(res, 201, response);
      } catch (error) {
        const summary = toErrorSummary(error);
        writeJson(res, toHttpStatusCode(summary), {
          code: summary.errorCode,
          message: summary.errorMessage,
        });
      }
      return;
    }

    const threadSnapshotMatch = /^\/api\/threads\/([^/]+)\/snapshot$/.exec(url.pathname);
    if (method === "GET" && threadSnapshotMatch?.[1]) {
      const threadId = decodeURIComponent(threadSnapshotMatch[1]);
      const snapshot = deps.buildThreadSnapshot(threadId);
      if (snapshot === undefined) {
        writeJson(res, 404, { code: "NOT_FOUND", message: `unknown threadId: ${threadId}` });
        return;
      }
      writeJson(res, 200, snapshot);
      return;
    }

    const threadMatch = /^\/api\/threads\/([^/]+)$/.exec(url.pathname);
    if (threadMatch?.[1]) {
      const threadId = decodeURIComponent(threadMatch[1]);
      if (method === "GET") {
        const thread = deps.threadRepository.getOrVirtual(threadId);
        if (thread === undefined) {
          writeJson(res, 404, { code: "NOT_FOUND", message: `unknown threadId: ${threadId}` });
          return;
        }
        const response: GetThreadResponse = thread;
        writeJson(res, 200, response);
        return;
      }

      if (method === "PATCH") {
        try {
          const payload = await readJsonBody<unknown>(req);
          if (!isUpdateThreadRequest(payload)) {
            writeJson(res, 400, {
              code: "INVALID_REQUEST",
              message: "only title/archived fields are allowed",
            });
            return;
          }
          const updated = await deps.threadRepository.update(threadId, {
            title: payload.title,
            archived: payload.archived,
          });
          if (updated === undefined) {
            writeJson(res, 404, { code: "NOT_FOUND", message: `unknown threadId: ${threadId}` });
            return;
          }
          const response: UpdateThreadResponse = updated;
          writeJson(res, 200, response);
        } catch (error) {
          const summary = toErrorSummary(error);
          writeJson(res, toHttpStatusCode(summary), {
            code: summary.errorCode,
            message: summary.errorMessage,
          });
        }
        return;
      }

      if (method === "DELETE") {
        try {
          if (threadId === "main") {
            writeJson(res, 403, {
              code: "FORBIDDEN",
              message: "main thread cannot be deleted",
            });
            return;
          }
          const deleted = await deps.threadRepository.delete(threadId);
          if (!deleted) {
            writeJson(res, 404, { code: "NOT_FOUND", message: `unknown threadId: ${threadId}` });
            return;
          }
          res.statusCode = 204;
          res.end();
        } catch (error) {
          const summary = toErrorSummary(error);
          writeJson(res, toHttpStatusCode(summary), {
            code: summary.errorCode,
            message: summary.errorMessage,
          });
        }
        return;
      }
    }

    if (method === "POST" && url.pathname === "/api/commands") {
      try {
        const payload = await readJsonBody<unknown>(req);
        if (!isCommandRequest(payload)) {
          writeJson(res, 400, {
            code: "INVALID_REQUEST",
            message: "sessionKey/message are required",
          });
          return;
        }

        const result = await deps.submitPrompt({
          sessionKey: payload.sessionKey.trim(),
          message: payload.message,
          idempotencyKey: normalizeIdempotencyKey(payload.idempotencyKey),
        });
        writeJson(res, 202, result.accepted);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("IDEMPOTENCY_CONFLICT:")) {
          writeJson(res, 409, {
            code: "INVALID_REQUEST",
            message: error.message.slice("IDEMPOTENCY_CONFLICT:".length).trim(),
          });
          return;
        }
        const summary = toErrorSummary(error);
        writeJson(res, toHttpStatusCode(summary), {
          code: summary.errorCode,
          message: summary.errorMessage,
        });
      }
      return;
    }

    if (method === "POST" && url.pathname === "/api/chat/messages") {
      try {
        const payload = await readJsonBody<unknown>(req);
        if (!isPostChatMessageRequest(payload)) {
          writeJson(res, 400, {
            code: "INVALID_REQUEST",
            message: "sessionKey/message/idempotencyKey are required",
          });
          return;
        }
        const sessionKey = payload.sessionKey.trim();
        const thread = deps.threadRepository.getOrVirtual(sessionKey);
        if (thread === undefined) {
          writeJson(res, 404, {
            code: "NOT_FOUND",
            message: `unknown sessionKey: ${sessionKey}`,
          });
          return;
        }
        const result = await deps.submitPrompt({
          sessionKey,
          message: payload.message,
          idempotencyKey: payload.idempotencyKey.trim(),
        });
        const response: PostChatMessageResponse = {
          runId: result.accepted.runId,
          status: result.accepted.status,
        };
        writeJson(res, 202, response);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("IDEMPOTENCY_CONFLICT:")) {
          writeJson(res, 409, {
            code: "INVALID_REQUEST",
            message: error.message.slice("IDEMPOTENCY_CONFLICT:".length).trim(),
          });
          return;
        }
        const summary = toErrorSummary(error);
        writeJson(res, toHttpStatusCode(summary), {
          code: summary.errorCode,
          message: summary.errorMessage,
        });
      }
      return;
    }

    const streamMatch = /^\/api\/chat\/runs\/([^/]+)\/stream$/.exec(url.pathname);
    if (method === "GET" && streamMatch?.[1]) {
      const runId = decodeURIComponent(streamMatch[1]);
      if (!deps.runEventBuffer.hasRun(runId)) {
        writeJson(res, 404, { code: "NOT_FOUND", message: `unknown runId: ${runId}` });
        return;
      }
      const parsedSeq = Number.parseInt(toQueryValue(url, "seq") ?? "0", 10);
      const fromSeq = Number.isFinite(parsedSeq) && parsedSeq >= 0 ? parsedSeq : 0;

      setupSseHeaders(res);
      const backfill = deps.runEventBuffer.replay(runId, fromSeq);
      for (const event of backfill) {
        writeSse(res, "chat", event);
      }

      const unsubscribe = deps.runEventBuffer.subscribe(runId, (event) => {
        writeSse(res, "chat", event);
      });
      req.on("close", () => {
        unsubscribe();
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/chat/history") {
      const sessionKey = toQueryValue(url, "sessionKey");
      if (sessionKey === undefined) {
        writeJson(res, 400, { code: "INVALID_REQUEST", message: "sessionKey is required" });
        return;
      }
      const response: GetChatHistoryResponse = {
        messages: deps.chatHistoryStore.list(sessionKey),
      };
      writeJson(res, 200, response);
      return;
    }

    if (method === "POST" && url.pathname === "/api/chat/abort") {
      try {
        const payload = await readJsonBody<unknown>(req);
        if (!isPostChatAbortRequest(payload)) {
          writeJson(res, 400, {
            code: "INVALID_REQUEST",
            message: "sessionKey is required",
          });
          return;
        }
        const runId =
          payload.runId ?? findLatestActiveRunIdBySessionKey(deps.runLifecycle, payload.sessionKey);
        if (runId === undefined) {
          writeJson(res, 404, {
            code: "NOT_FOUND",
            message: "no active run for session",
          });
          return;
        }
        const run = deps.runLifecycle.runs().get(runId);
        if (run === undefined || typeof run.sessionId !== "string") {
          writeJson(res, 404, {
            code: "NOT_FOUND",
            message: `unknown runId: ${runId}`,
          });
          return;
        }
        if (run.sessionKey !== payload.sessionKey || !isActiveRunStatus(run.status)) {
          writeJson(res, 404, {
            code: "NOT_FOUND",
            message: "no active run for session",
          });
          return;
        }

        deps.runLifecycle.clearActiveSessionRun(run.sessionId);
        try {
          await deps.supervisor.request(
            "session/cancel",
            { sessionId: run.sessionId },
            { timeoutMs: 5_000 }
          );
        } catch {
          // Worker cancel failure is treated as best-effort cancellation on control-plane side.
        }
        deps.permissionGateway.cancelSession(run.sessionId);
        const cancelled = deps.runLifecycle.cancelRun(runId, "cancelled");
        if (cancelled === undefined) {
          writeJson(res, 404, {
            code: "NOT_FOUND",
            message: "no active run for session",
          });
          return;
        }
        deps.runEventBuffer.append(
          runId,
          mapAbortToChatStreamEvent({
            runId,
            sessionKey: run.sessionKey,
          })
        );
        writeJson(res, 200, {});
      } catch (error) {
        const summary = toErrorSummary(error);
        writeJson(res, toHttpStatusCode(summary), {
          code: summary.errorCode,
          message: summary.errorMessage,
        });
      }
      return;
    }

    const runAuditMatch = /^\/api\/chat\/runs\/([^/]+)\/audit$/.exec(url.pathname);
    if (method === "GET" && runAuditMatch?.[1]) {
      const runId = decodeURIComponent(runAuditMatch[1]);
      const audit = await deps.readRunAudit(runId);
      writeJson(res, 200, audit);
      return;
    }

    if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(deps.renderRootPage());
      return;
    }

    writeJson(res, 404, { code: "NOT_FOUND", message: `${method} ${url.pathname}` });
  };
}
