import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  handleTerminalRecord,
  type TerminalRecord,
} from "../../src/assistant/terminal-record-handler.js";
import type {
  DualWriteAppendResult,
  DualWriteCoordinator,
} from "../../src/proactive/dual-write-coordinator.js";

function createDualWriteCoordinatorStub(result: DualWriteAppendResult): DualWriteCoordinator {
  return {
    appendEvent: async () => ({ status: "committed" }),
    appendAssistant: async () => result,
    retryPending: async () => ({
      timelineRecovered: 0,
      sessionRecovered: 0,
      pendingTimeline: 0,
      pendingSessionBackfill: 0,
    }),
    hasPendingTimelineWrites: () => false,
    hasPendingSessionBackfill: () => false,
    listPendingSessionBackfillUids: () => [],
  };
}

function createTerminalInput(
  actionType: TerminalRecord["actionType"] = "assistant_final"
): TerminalRecord {
  return {
    runId: "run-1",
    sessionKey: "slack:channel:C123",
    actionType,
    ts: "2026-02-22T12:34:56.000Z",
    durationMs: 1234,
  };
}

describe("terminal-record-handler", () => {
  it("assistant_final + committed(offsetあり) は watermark に反映する", async () => {
    const applied: Array<Record<string, unknown>> = [];
    const warnings: string[] = [];

    await handleTerminalRecord(
      {
        dualWriteCoordinator: createDualWriteCoordinatorStub({
          status: "committed",
          timelineOffset: 88,
        }),
        watermarkStore: {
          applyTerminalRecord: async (input) => {
            applied.push(input as unknown as Record<string, unknown>);
            return {
              schema: "adjutant.watermarks.v1",
              updatedAt: "2026-02-22T12:35:00.000Z",
              scan: {
                timelinePath: "memory/timeline.jsonl",
                lastScannedOffset: 0,
                lastGoodOffset: 0,
              },
              sessions: {},
            };
          },
        },
        onWarn: (message) => warnings.push(message),
      },
      createTerminalInput("assistant_final")
    );

    assert.equal(applied.length, 1);
    assert.equal(applied[0]?.sessionKey, "slack:channel:C123");
    assert.equal(applied[0]?.actionType, "assistant_final");
    assert.equal(applied[0]?.offset, 88);
    assert.deepEqual(warnings, []);
  });

  it("pending-timeline のときは watermark を更新しない", async () => {
    let applied = 0;
    const warnings: string[] = [];

    await handleTerminalRecord(
      {
        dualWriteCoordinator: createDualWriteCoordinatorStub({
          status: "pending-timeline",
        }),
        watermarkStore: {
          applyTerminalRecord: async () => {
            applied += 1;
            throw new Error("should not be called");
          },
        },
        onWarn: (message) => warnings.push(message),
      },
      createTerminalInput("assistant_final")
    );

    assert.equal(applied, 0);
    assert.deepEqual(warnings, ["terminal-record-queued"]);
  });

  it("pending-session-backfill(offsetあり) でも watermark 更新を実行する", async () => {
    let applied = 0;
    const warnings: string[] = [];

    await handleTerminalRecord(
      {
        dualWriteCoordinator: createDualWriteCoordinatorStub({
          status: "pending-session-backfill",
          timelineOffset: 144,
        }),
        watermarkStore: {
          applyTerminalRecord: async () => {
            applied += 1;
            return {
              schema: "adjutant.watermarks.v1",
              updatedAt: "2026-02-22T12:35:00.000Z",
              scan: {
                timelinePath: "memory/timeline.jsonl",
                lastScannedOffset: 0,
                lastGoodOffset: 0,
              },
              sessions: {},
            };
          },
        },
        onWarn: (message) => warnings.push(message),
      },
      createTerminalInput("assistant_final")
    );

    assert.equal(applied, 1);
    assert.deepEqual(warnings, ["terminal-record-queued"]);
  });
});
