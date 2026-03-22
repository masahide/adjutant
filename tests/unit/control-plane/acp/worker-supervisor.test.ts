import assert from "node:assert/strict";
import test from "node:test";

import { WorkerSupervisor } from "../../../../src/control-plane/acp/worker-supervisor.js";

const CHILD_SCRIPT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let promptRequestId = null;
function write(envelope) {
  process.stdout.write(JSON.stringify(envelope) + "\\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    return;
  }
  if (message.method === "session/prompt") {
    promptRequestId = message.id;
    write({
      jsonrpc: "2.0",
      id: 91,
      method: "session/request_permission",
      params: {
        sessionId: "sess_1",
        toolCall: {
          toolCallId: "tool_1",
          title: "write",
        },
        options: [
          { optionId: "allow_once", name: "Approve", kind: "allow_once" },
          { optionId: "reject_once", name: "Deny", kind: "reject_once" }
        ]
      }
    });
    return;
  }
  if (message.id === 91 && message.result) {
    write({
      jsonrpc: "2.0",
      id: promptRequestId,
      result: {
        stopReason: "end_turn",
        text: message.result.outcome.optionId
      }
    });
  }
});
`;

test("WorkerSupervisor handles child-originated session/request_permission", async (t) => {
  const supervisor = new WorkerSupervisor({
    command: process.execPath,
    args: ["-e", CHILD_SCRIPT],
    cwd: process.cwd(),
    onRequest: async (request) => {
      assert.equal(request.method, "session/request_permission");
      return {
        outcome: {
          outcome: "selected",
          optionId: "allow_once",
        },
      };
    },
  });

  await supervisor.start();
  t.after(async () => {
    await supervisor.stop();
  });

  const initialized = await supervisor.request("initialize", { protocolVersion: 1 });
  assert.equal(initialized.protocolVersion, 1);

  const result = await supervisor.request("session/prompt", {
    sessionId: "sess_1",
    prompt: "hello",
  });
  assert.equal(result.text, "allow_once");
});
