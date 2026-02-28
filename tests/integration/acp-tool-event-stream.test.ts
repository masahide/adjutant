import assert from "node:assert/strict";
import test from "node:test";

import { ACP_CLIENT_METHODS } from "../../src/contracts/acp/method-types.js";
import type { ClientNotification } from "../../src/contracts/acp/rpc-types.js";
import { UiRuntime } from "../../src/ui/runtime.js";

function toolUpdate(sessionId: string, update: Record<string, unknown>): ClientNotification {
  return {
    jsonrpc: "2.0",
    method: ACP_CLIENT_METHODS.SESSION_UPDATE,
    params: {
      sessionId,
      update,
    },
  };
}

test("tool event bridge restores missing start and dedupes duplicate update", () => {
  const runtime = new UiRuntime({
    resolveRunId: (sessionId) => (sessionId === "sess_1" ? "run_1" : undefined),
  });

  runtime.onAcpSessionUpdate(
    toolUpdate("sess_1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "in_progress",
      rawOutput: { lines: 10 },
    })
  );

  runtime.onAcpSessionUpdate(
    toolUpdate("sess_1", {
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: "Run tests",
      kind: "execute",
      status: "pending",
      rawInput: { command: "pnpm test" },
    })
  );

  runtime.onAcpSessionUpdate(
    toolUpdate("sess_1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      rawOutput: { exitCode: 0 },
    })
  );

  runtime.onAcpSessionUpdate(
    toolUpdate("sess_1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      rawOutput: { exitCode: 0 },
    })
  );

  const events = runtime.listToolEvents("run_1");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.toolCallId, "call_1");
  assert.equal(events[0]?.title, "Run tests");
  assert.equal(events[0]?.kind, "execute");
  assert.equal(events[0]?.status, "completed");
  assert.deepEqual(events[0]?.rawInput, { command: "pnpm test" });
  assert.deepEqual(events[0]?.rawOutput, { exitCode: 0 });
});
