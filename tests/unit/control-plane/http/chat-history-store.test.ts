import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ChatHistoryStore } from "../../../../src/control-plane/http/chat-history-store.js";

test("ChatHistoryStore は legacy と日次 journal を読み込み timestamp 順で復元する", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "adjutant-chat-history-store-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const journalDir = join(root, "chat-history");
  await mkdir(journalDir, { recursive: true });
  const legacyJournalPath = join(root, "chat-history.jsonl");
  await writeFile(
    legacyJournalPath,
    [
      JSON.stringify({
        sessionKey: "main",
        role: "user",
        content: "legacy-user",
        timestamp: "2026-03-13T23:59:59.000Z",
      }),
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(journalDir, "2026-03-14.jsonl"),
    [
      JSON.stringify({
        sessionKey: "main",
        role: "assistant",
        content: "daily-assistant",
        timestamp: "2026-03-14T00:00:01.000Z",
      }),
      JSON.stringify({
        sessionKey: "main",
        role: "user",
        content: "daily-user",
        timestamp: "2026-03-14T00:00:02.000Z",
      }),
    ].join("\n"),
    "utf8"
  );

  const store = new ChatHistoryStore({ journalDir, legacyJournalPath });
  await store.initialize();

  const history = store.list("main");
  assert.deepEqual(
    history.map((item) => ({ role: item.role, content: item.content })),
    [
      { role: "user", content: "legacy-user" },
      { role: "assistant", content: "daily-assistant" },
      { role: "user", content: "daily-user" },
    ]
  );
});

test("ChatHistoryStore は timestamp の日付に対応する journal へ追記する", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "adjutant-chat-history-store-append-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const journalDir = join(root, "chat-history");
  const store = new ChatHistoryStore({ journalDir });
  await store.initialize();

  store.appendUserMessage({
    sessionKey: "main",
    runId: "run:1",
    message: "rotated-history-entry",
    timestamp: "2026-03-14T10:00:00.000Z",
  });

  await new Promise((resolve) => setTimeout(resolve, 30));

  const written = await readFile(join(journalDir, "2026-03-14.jsonl"), "utf8");
  assert.equal(written.includes("rotated-history-entry"), true);
  assert.equal(store.list("main")[0]?.content, "rotated-history-entry");
});
