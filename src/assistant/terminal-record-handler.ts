import type {
  DualWriteAppendResult,
  DualWriteCoordinator,
  DualWriteRecord,
} from "../proactive/dual-write-coordinator.js";
import { TIMELINE_RECORD_SCHEMA_V1_5, type TimelineActionType } from "../proactive/types.js";
import type { WatermarkStore } from "../proactive/watermark-store.js";

export type TerminalRecord = {
  runId: string;
  sessionKey: string;
  actionType: TimelineActionType;
  ts: string;
  durationMs: number;
  reason?: string;
};

export type TerminalRecordHandlerDeps = {
  dualWriteCoordinator: DualWriteCoordinator;
  watermarkStore: Pick<WatermarkStore, "applyTerminalRecord">;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
};

export async function handleTerminalRecord(
  deps: TerminalRecordHandlerDeps,
  terminal: TerminalRecord
): Promise<DualWriteAppendResult> {
  const uid = `${terminal.runId}:${terminal.actionType}`;
  const baseRecord: DualWriteRecord = {
    schema: TIMELINE_RECORD_SCHEMA_V1_5,
    uid,
    sessionKey: terminal.sessionKey,
    recordType: "action",
    role: "assistant",
    actionType: terminal.actionType,
    runId: terminal.runId,
    ts: terminal.ts,
    loggedAt: terminal.ts,
    reason: terminal.reason,
    durationMs: terminal.durationMs,
  };

  const result = await deps.dualWriteCoordinator.appendAssistant({
    uid,
    timelineRecord: { ...baseRecord, target: "timeline" },
    sessionRecord: { ...baseRecord, target: "session" },
  });

  if (result.status !== "pending-timeline") {
    if (typeof result.timelineOffset === "number") {
      try {
        await deps.watermarkStore.applyTerminalRecord({
          sessionKey: terminal.sessionKey,
          actionType: terminal.actionType,
          offset: result.timelineOffset,
          ts: terminal.ts,
        });
      } catch (error) {
        deps.onWarn?.("terminal-watermark-apply-failed", {
          runId: terminal.runId,
          sessionKey: terminal.sessionKey,
          actionType: terminal.actionType,
          timelineOffset: result.timelineOffset,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      deps.onWarn?.("terminal-timeline-offset-missing", {
        runId: terminal.runId,
        sessionKey: terminal.sessionKey,
        actionType: terminal.actionType,
        status: result.status,
      });
    }
  }

  if (result.status !== "committed") {
    const queuedMeta: Record<string, unknown> = {
      runId: terminal.runId,
      sessionKey: terminal.sessionKey,
      actionType: terminal.actionType,
      status: result.status,
    };
    if ("timelineOffset" in result) {
      queuedMeta.timelineOffset = result.timelineOffset;
    }
    deps.onWarn?.("terminal-record-queued", {
      ...queuedMeta,
    });
  }

  return result;
}
