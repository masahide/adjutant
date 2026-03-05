import assert from "node:assert/strict";
import test from "node:test";

import type { JournalRecord } from "../../../../src/runtime/journal-store.js";
import { replayPendingRecords } from "../../../../src/control-plane/process-rpc/replay-runner.js";

test("replayPendingRecords は replayPending の順序で apply する", async () => {
  const calls: string[] = [];
  const source = {
    async replayPending(): Promise<JournalRecord<{ id: string }>[]> {
      return [
        { cursor: { segment: 0, offset: 0 }, value: { id: "a" } },
        { cursor: { segment: 0, offset: 1 }, value: { id: "b" } },
      ];
    },
  };

  const count = await replayPendingRecords({
    source,
    apply: async (record) => {
      calls.push(`${record.value.id}:${record.cursor.offset}`);
    },
  });

  assert.equal(count, 2);
  assert.deepEqual(calls, ["a:0", "b:1"]);
});

test("replayPendingRecords は pending が空なら apply しない", async () => {
  let called = false;
  const count = await replayPendingRecords({
    source: {
      async replayPending(): Promise<JournalRecord<{ id: string }>[]> {
        return [];
      },
    },
    apply: () => {
      called = true;
    },
  });

  assert.equal(count, 0);
  assert.equal(called, false);
});
