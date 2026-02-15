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
  const abortCtrl = {
    abort: () => {
      aborted = true;
    },
  };
  activeRuns.set(runId, { sessionKey, abort: abortCtrl.abort, seqRef });

  logRunStatus(runId, sessionKey, "queued");

  const lane = resolveSessionLane(sessionKey);
  enqueueCommandInLane(lane, () =>
    enqueueCommand(async () => {
      try {
        logRunStatus(runId, sessionKey, "running");

        if (aborted) {
          StreamEventBridge.emit({
            runId,
            sessionKey,
            seq: ++seqRef.value,
            state: "aborted",
            errorMessage: "Run was aborted before execution",
          });
          IdempotencyRegistry.updateStatus(runId, "error");
          logRunStatus(runId, sessionKey, "failed", "aborted-before-execution");
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
          // Agent finished but abort was requested during execution
          if (!StreamEventBridge.getTerminal(runId)) {
            StreamEventBridge.emit({
              runId,
              sessionKey,
              seq: ++seqRef.value,
              state: "aborted",
              errorMessage: "Run was aborted during execution",
            });
          }
          IdempotencyRegistry.updateStatus(runId, "error");
          logRunStatus(runId, sessionKey, "failed", "aborted-during-execution");
          return;
        }

        if (result.status === "completed") {
          // Guard: ensure terminal event was emitted by AgentRunner
          if (!StreamEventBridge.getTerminal(runId)) {
            StreamEventBridge.emit({
              runId,
              sessionKey,
              seq: ++seqRef.value,
              state: "final",
            });
          }
          IdempotencyRegistry.updateStatus(runId, "ok");
          logRunStatus(runId, sessionKey, "completed");
        } else {
          // Fix #3: failed status → emit error terminal
          if (!StreamEventBridge.getTerminal(runId)) {
            StreamEventBridge.emit({
              runId,
              sessionKey,
              seq: ++seqRef.value,
              state: "error",
              errorMessage: result.reason ?? "Agent failed",
            });
          }
          IdempotencyRegistry.updateStatus(runId, "error");
          logRunStatus(runId, sessionKey, "failed", result.reason);
        }
      } catch (err) {
        if (!StreamEventBridge.getTerminal(runId)) {
          StreamEventBridge.emit({
            runId,
            sessionKey,
            seq: ++seqRef.value,
            state: "error",
            errorMessage: err instanceof Error ? err.message : "Unknown error",
          });
        }
        IdempotencyRegistry.updateStatus(runId, "error");
        logRunStatus(runId, sessionKey, "failed", err instanceof Error ? err.message : "unknown");
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
      // Emit aborted terminal if not already terminated
      if (!StreamEventBridge.getTerminal(req.runId)) {
        StreamEventBridge.emit({
          runId: req.runId,
          sessionKey: req.sessionKey,
          seq: ++run.seqRef.value,
          state: "aborted",
          errorMessage: "Aborted by user",
        });
      }
      abortedIds.push(req.runId);
    }
  } else {
    for (const [runId, run] of activeRuns) {
      if (run.sessionKey === req.sessionKey) {
        run.abort();
        if (!StreamEventBridge.getTerminal(runId)) {
          StreamEventBridge.emit({
            runId,
            sessionKey: req.sessionKey,
            seq: ++run.seqRef.value,
            state: "aborted",
            errorMessage: "Aborted by user",
          });
        }
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
