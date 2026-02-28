import assert from "node:assert/strict";
import test from "node:test";

import { handleSessionCancel } from "../../../src/agent-worker-acp/handlers/session-cancel.js";

test("handleSessionCancel delegates abort to adapter", () => {
  let calledWith = "";

  const result = handleSessionCancel(
    { sessionId: "sess_1" },
    {
      adapter: {
        cancelSession(sessionId: string): boolean {
          calledWith = sessionId;
          return true;
        },
      },
    }
  );

  assert.equal(calledWith, "sess_1");
  assert.deepEqual(result, { cancelled: true });
});
