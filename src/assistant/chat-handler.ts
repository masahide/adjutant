import type {
  PostChatMessageRequest,
  PostChatMessageResponse,
  PostChatAbortRequest,
  PostChatAbortResponse,
} from "./api-types.js";
import type { StreamEvent, AgentRunStatus } from "./types.js";
import * as IdempotencyRegistry from "./idempotency-registry.js";
import * as StreamEventBridge from "./stream-event-bridge.js";
import { createHash } from "node:crypto";
import {
  drainSystemEvents,
  resolveSessionLane,
  enqueueCommandInLane,
  enqueueCommand,
} from "./index.js";

export type AgentRunFn = (opts: {
  prompt: string;
  sessionKey: string;
  runId: string;
  origin: "user" | "pipeline" | "system";
  onDelta: (event: StreamEvent) => void;
}) => Promise<{ status: "completed" | "failed"; reason?: string }>;

export type ChatHandlerConfig = {
  runAgent: AgentRunFn;
  dataDir: string;
  workspaceDir: string;
  timezone: string;
  idempotencyTtlSec: number;
  idempotencyStorePath?: string;
  idempotencyMaxEntries?: number;
  idempotencyStoreFailureMode?: "open" | "closed";
};

const DEFAULT_CONFIG: Partial<ChatHandlerConfig> = {
  timezone: "Asia/Tokyo",
  idempotencyTtlSec: 300,
};

let config: ChatHandlerConfig | null = null;

const activeRuns = new Map<
  string,
  { sessionKey: string; storeKey: string; abort: () => void; seqRef: { value: number } }
>();

export function configure(userConfig: ChatHandlerConfig): void {
  config = { ...DEFAULT_CONFIG, ...userConfig };
  IdempotencyRegistry.configureRegistry({
    storePath: userConfig.idempotencyStorePath,
    maxEntries: userConfig.idempotencyMaxEntries,
    storeFailureMode: userConfig.idempotencyStoreFailureMode,
  });
  IdempotencyRegistry.loadFromStore();
}

function getConfig(): ChatHandlerConfig {
  if (!config) throw new Error("ChatHandler not configured. Call configure() first.");
  return config;
}

/** Emit terminal event (if not already emitted), update idempotency status, and log. */
function finalizeRun(
  runId: string,
  storeKey: string,
  sessionKey: string,
  seqRef: { value: number },
  terminal: StreamEvent["state"],
  errorMessage?: string
): void {
  if (!StreamEventBridge.getTerminal(runId)) {
    StreamEventBridge.emit({
      runId,
      sessionKey,
      seq: ++seqRef.value,
      state: terminal,
      errorMessage,
    });
  }
  IdempotencyRegistry.updateStatus(storeKey, terminal === "final" ? "ok" : "error");
  logRunStatus(runId, sessionKey, terminal === "final" ? "completed" : "failed", errorMessage);
}

export function acceptMessage(req: PostChatMessageRequest): PostChatMessageResponse {
  const cfg = getConfig();
  if (!req.sessionKey || req.sessionKey.trim() === "") {
    throw new ValidationError("sessionKey is required");
  }
  if (!req.idempotencyKey || req.idempotencyKey.trim() === "") {
    throw new ValidationError("idempotencyKey is required");
  }
  if (!req.message || req.message.trim() === "") {
    throw new ValidationError("message is required");
  }

  const fingerprint = buildRequestFingerprint(req);
  const dedup = IdempotencyRegistry.getOrCreate(
    req.sessionKey,
    req.idempotencyKey,
    fingerprint,
    cfg.idempotencyTtlSec
  );

  if (dedup.kind === "conflict") {
    throw new IdempotencyPayloadMismatchError();
  }

  if (dedup.kind === "existing") {
    return { runId: dedup.runId, status: dedup.status };
  }

  const { runId, storeKey } = dedup;

  startRun(runId, storeKey, req.sessionKey, req.message, normalizeOrigin(req.origin));

  return { runId, status: "started" };
}

function buildRequestFingerprint(req: PostChatMessageRequest): string {
  const origin = normalizeOrigin(req.origin);
  return createHash("sha256")
    .update(
      JSON.stringify({
        sessionKey: req.sessionKey.trim(),
        message: req.message.trim(),
        origin,
      })
    )
    .digest("hex");
}

function startRun(
  runId: string,
  storeKey: string,
  sessionKey: string,
  message: string,
  origin: "user" | "pipeline" | "system"
): void {
  const cfg = getConfig();
  let aborted = false;
  const seqRef = { value: 0 };
  activeRuns.set(runId, {
    sessionKey,
    storeKey,
    abort: () => {
      aborted = true;
    },
    seqRef,
  });

  logRunStatus(runId, sessionKey, "queued");

  const lane = resolveSessionLane(sessionKey);
  enqueueCommandInLane(lane, () =>
    enqueueCommand(async () => {
      try {
        logRunStatus(runId, sessionKey, "running");

        if (aborted) {
          finalizeRun(
            runId,
            storeKey,
            sessionKey,
            seqRef,
            "aborted",
            "Run was aborted before execution"
          );
          return;
        }

        const prompt = buildChatPrompt(message, drainSystemEvents(sessionKey));

        const result = await cfg.runAgent({
          prompt,
          sessionKey,
          runId,
          origin,
          onDelta: (event) => {
            if (!aborted) {
              StreamEventBridge.emit({ ...event, seq: ++seqRef.value });
            }
          },
        });

        if (aborted) {
          finalizeRun(
            runId,
            storeKey,
            sessionKey,
            seqRef,
            "aborted",
            "Run was aborted during execution"
          );
          return;
        }

        if (result.status === "completed") {
          finalizeRun(runId, storeKey, sessionKey, seqRef, "final");
        } else {
          finalizeRun(
            runId,
            storeKey,
            sessionKey,
            seqRef,
            "error",
            result.reason ?? "Agent failed"
          );
        }
      } catch (err) {
        finalizeRun(
          runId,
          storeKey,
          sessionKey,
          seqRef,
          "error",
          err instanceof Error ? err.message : "Unknown error"
        );
      } finally {
        activeRuns.delete(runId);
      }
    })
  );
}

function normalizeOrigin(value: unknown): "user" | "pipeline" | "system" {
  if (value === "pipeline" || value === "system") {
    return value;
  }
  return "user";
}

function renderSystemEventsSection(systemEvents: string[]): string | null {
  const cleaned = systemEvents.map((event) => event.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return null;
  }
  return `## System Events\n${cleaned.map((event) => `- ${event}`).join("\n")}`;
}

function buildChatPrompt(message: string, systemEvents: string[]): string {
  const sections: string[] = [];
  const systemEventsSection = renderSystemEventsSection(systemEvents);
  if (systemEventsSection) {
    sections.push(systemEventsSection);
  }
  sections.push(`## User Message\n${message}`);
  return sections.join("\n\n");
}

export function abort(req: PostChatAbortRequest): PostChatAbortResponse {
  const abortedIds: string[] = [];

  if (req.runId) {
    const run = activeRuns.get(req.runId);
    if (run && run.sessionKey === req.sessionKey) {
      run.abort();
      finalizeRun(
        req.runId,
        run.storeKey,
        req.sessionKey,
        run.seqRef,
        "aborted",
        "Aborted by user"
      );
      abortedIds.push(req.runId);
    }
  } else {
    for (const [runId, run] of activeRuns) {
      if (run.sessionKey === req.sessionKey) {
        run.abort();
        finalizeRun(runId, run.storeKey, req.sessionKey, run.seqRef, "aborted", "Aborted by user");
        abortedIds.push(runId);
      }
    }
  }

  return { ok: true, aborted: abortedIds.length, runIds: abortedIds };
}

function logRunStatus(
  runId: string,
  sessionKey: string,
  status: AgentRunStatus["status"],
  reason?: string
): void {
  const record: AgentRunStatus = {
    schema: "adjutant.agent.run-status.v1",
    sessionId: sessionKey,
    sessionKey,
    runId,
    status,
    reason,
    updatedAt: new Date().toISOString(),
  };
  console.log("[AgentRunStatus]", JSON.stringify(record));
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class IdempotencyPayloadMismatchError extends Error {
  readonly code = "IDEMPOTENCY_PAYLOAD_MISMATCH";
  constructor() {
    super("same idempotency key was used with different payload");
    this.name = "IdempotencyPayloadMismatchError";
  }
}

export function resetForTest(): void {
  config = null;
  activeRuns.clear();
  IdempotencyRegistry.resetForTest();
  StreamEventBridge.resetForTest();
}
