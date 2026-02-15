import type {
  PostChatMessageRequest,
  PostChatMessageResponse,
  PostChatAbortRequest,
  PostChatAbortResponse,
} from "./api-types.js";
import type { StreamEvent, AgentRunStatus } from "./types.js";
import * as IdempotencyRegistry from "./idempotency-registry.js";
import * as StreamEventBridge from "./stream-event-bridge.js";
import {
  drainSystemEvents,
  resolveSessionLane,
  enqueueCommandInLane,
  enqueueCommand,
  buildEventContext,
  readMemoryFiles,
  loadRecentSessionEvents,
} from "./index.js";

export type AgentRunFn = (opts: {
  prompt: string;
  sessionKey: string;
  runId: string;
  onDelta: (event: StreamEvent) => void;
}) => Promise<{ status: "completed" | "failed"; reason?: string }>;

export type ChatHandlerConfig = {
  runAgent: AgentRunFn;
  dataDir: string;
  workspaceDir: string;
  timezone: string;
  transcriptLimit: number;
  idempotencyTtlSec: number;
};

const DEFAULT_CONFIG: Partial<ChatHandlerConfig> = {
  timezone: "Asia/Tokyo",
  transcriptLimit: 20,
  idempotencyTtlSec: 300,
};

let config: ChatHandlerConfig | null = null;

const activeRuns = new Map<
  string,
  { sessionKey: string; abort: () => void; seqRef: { value: number } }
>();

export function configure(userConfig: ChatHandlerConfig): void {
  config = { ...DEFAULT_CONFIG, ...userConfig };
}

function getConfig(): ChatHandlerConfig {
  if (!config) throw new Error("ChatHandler not configured. Call configure() first.");
  return config;
}

/** Emit terminal event (if not already emitted), update idempotency status, and log. */
function finalizeRun(
  runId: string,
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
  IdempotencyRegistry.updateStatus(runId, terminal === "final" ? "ok" : "error");
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

  const dedup = IdempotencyRegistry.getOrCreate(
    req.sessionKey,
    req.idempotencyKey,
    cfg.idempotencyTtlSec
  );

  if (dedup.kind === "existing") {
    return { runId: dedup.runId, status: dedup.status };
  }

  const { runId } = dedup;

  startRun(runId, req.sessionKey, req.message);

  return { runId, status: "started" };
}

function startRun(runId: string, sessionKey: string, message: string): void {
  const cfg = getConfig();
  let aborted = false;
  const seqRef = { value: 0 };
  activeRuns.set(runId, {
    sessionKey,
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
          finalizeRun(runId, sessionKey, seqRef, "aborted", "Run was aborted before execution");
          return;
        }

        const systemEvents = drainSystemEvents(sessionKey);

        const [memory, transcript] = await Promise.all([
          readMemoryFiles({
            workspaceDir: cfg.workspaceDir,
            timezone: cfg.timezone,
          }),
          loadRecentSessionEvents({
            sessionKey,
            limit: cfg.transcriptLimit,
          }),
        ]);

        const context = buildEventContext({
          events: [],
          systemEvents,
          recentTranscript: transcript,
          memoryContent: memory.longTerm ?? undefined,
          dailyMemoryContent: memory.daily ?? undefined,
          yesterdayMemoryContent: memory.yesterday ?? undefined,
        });

        const prompt = `${context.text}\n\n## User Message\n${message}`;

        const result = await cfg.runAgent({
          prompt,
          sessionKey,
          runId,
          onDelta: (event) => {
            if (!aborted) {
              StreamEventBridge.emit({ ...event, seq: ++seqRef.value });
            }
          },
        });

        if (aborted) {
          finalizeRun(runId, sessionKey, seqRef, "aborted", "Run was aborted during execution");
          return;
        }

        if (result.status === "completed") {
          finalizeRun(runId, sessionKey, seqRef, "final");
        } else {
          finalizeRun(runId, sessionKey, seqRef, "error", result.reason ?? "Agent failed");
        }
      } catch (err) {
        finalizeRun(
          runId,
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

export function abort(req: PostChatAbortRequest): PostChatAbortResponse {
  const abortedIds: string[] = [];

  if (req.runId) {
    const run = activeRuns.get(req.runId);
    if (run && run.sessionKey === req.sessionKey) {
      run.abort();
      finalizeRun(req.runId, req.sessionKey, run.seqRef, "aborted", "Aborted by user");
      abortedIds.push(req.runId);
    }
  } else {
    for (const [runId, run] of activeRuns) {
      if (run.sessionKey === req.sessionKey) {
        run.abort();
        finalizeRun(runId, req.sessionKey, run.seqRef, "aborted", "Aborted by user");
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

export function resetForTest(): void {
  config = null;
  activeRuns.clear();
  IdempotencyRegistry.resetForTest();
  StreamEventBridge.resetForTest();
}
