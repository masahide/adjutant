import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { NormalizedEvent } from "../../../src/core/events.js";
import {
  SelfActivityStore,
  toSelfActivityRecord,
} from "../../../src/collector-slack/self-activity-store.js";

test("self reaction の本文スナップショットを保持した record を作る", () => {
  const event: NormalizedEvent = {
    schema: "adjutant.event.v1.1",
    uid: "slack:C123@1730000000.123:eyes:added:U1",
    source: "slack",
    kind: "reaction",
    action: "added",
    ts: "2026-03-14T10:00:00.000Z",
    logged_at: "2026-03-14T10:00:01.000Z",
    detail: {
      slack: {
        channel_id: "C123",
        message_ts: "1730000000.123",
        thread_ts: "1730000000.001",
        emoji: "eyes",
        message_text: "確認対象です",
      },
    },
  };

  const record = toSelfActivityRecord(event);
  assert.ok(record);
  assert.equal(record.kind, "self_reaction");
  assert.equal(record.message_text, "確認対象です");
  assert.equal(record.emoji, "eyes");
  assert.equal(record.thread_ts, "1730000000.001");
});

test("self activity を日次ファイルへ append する", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "adjutant-self-activity-"));
  const store = new SelfActivityStore({
    dataDir,
    now: () => new Date("2026-03-14T19:00:00.000+09:00"),
  });
  const postEvent: NormalizedEvent = {
    schema: "adjutant.event.v1.1",
    uid: "slack:C123@1730000000.123",
    source: "slack",
    kind: "post",
    ts: "2026-03-14T10:00:00.000Z",
    logged_at: "2026-03-14T10:00:01.000Z",
    detail: {
      slack: {
        channel_id: "C123",
        message_ts: "1730000000.123",
        text: "自分の投稿",
      },
    },
  };
  const reactionEvent: NormalizedEvent = {
    schema: "adjutant.event.v1.1",
    uid: "slack:C123@1730000000.123:eyes:added:U1",
    source: "slack",
    kind: "reaction",
    action: "added",
    ts: "2026-03-14T10:00:02.000Z",
    logged_at: "2026-03-14T10:00:03.000Z",
    detail: {
      slack: {
        channel_id: "C123",
        message_ts: "1730000000.123",
        emoji: "eyes",
        message_text: "反応先本文",
      },
    },
  };

  await store.append(postEvent);
  await store.append(reactionEvent);

  const saved = await readFile(
    join(dataDir, "state", "activity", "self", "2026-03-14.jsonl"),
    "utf8"
  );
  const lines = saved
    .trim()
    .split("\n")
    .map(
      (line) => JSON.parse(line) as { kind: string; message_text?: string; event: NormalizedEvent }
    );

  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.kind, "self_post");
  assert.equal(lines[0]?.message_text, "自分の投稿");
  assert.equal(lines[1]?.kind, "self_reaction");
  assert.equal(lines[1]?.message_text, "反応先本文");
  assert.equal(lines[1]?.event.uid, reactionEvent.uid);
});
