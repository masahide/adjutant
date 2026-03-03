import assert from "node:assert/strict";
import test from "node:test";

import { buildSnapshotResponse } from "../../../../src/control-plane/http/snapshot-builder.js";

test("buildSnapshotResponse projects tool history and pending permissions", () => {
  const snapshot = buildSnapshotResponse({
    runById: new Map([
      [
        "run_1",
        {
          runId: "run_1",
          sessionKey: "main",
          sessionId: "sess_1",
          status: "completed",
          acceptedAt: "2026-02-28T12:00:00.000Z",
        },
      ],
    ]),
    listToolEvents: () => [
      {
        runId: "run_1",
        sessionId: "sess_1",
        toolCallId: "call_missing_status",
        updatedAt: "2026-02-28T12:00:01.000Z",
      },
      {
        runId: "run_1",
        sessionId: "sess_1",
        toolCallId: "call_completed",
        status: "completed",
        title: "fake_tool",
        kind: "execute",
        rawInput: { query: "hello" },
        rawOutput: { ok: true },
        updatedAt: "2026-02-28T12:00:02.000Z",
      },
    ],
    listPendingPermissions: () => [
      {
        requestId: "perm_1",
        sessionId: "sess_1",
        runId: "run_1",
        toolCallId: "call_completed",
        title: "allow fake tool",
        createdAt: "2026-02-28T12:00:03.000Z",
      },
    ],
  });

  assert.equal(snapshot.runs.length, 1);
  assert.equal(snapshot.toolEventsByRun.run_1?.length, 1);
  assert.equal(snapshot.toolEventsByRun.run_1?.[0]?.toolCallId, "call_completed");
  assert.deepEqual(snapshot.toolEventsByRun.run_1?.[0]?.rawInput, { query: "hello" });
  assert.deepEqual(snapshot.toolEventsByRun.run_1?.[0]?.rawOutput, { ok: true });
  assert.equal(snapshot.pendingPermissions.length, 1);
  assert.equal(snapshot.pendingPermissions[0]?.requestedAt, "2026-02-28T12:00:03.000Z");
});
