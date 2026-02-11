import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlWriter } from "../src/io/jsonlWriter.js";
import type { NormalizedEvent } from "../src/core/events.js";

const createEvent = (overrides: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  schema: "reaclog.event.v1.1",
  uid: overrides.uid ?? "slack:C123@1711111111.000200",
  source: "slack",
  kind: overrides.kind ?? "post",
  actor: "tester",
  subject: "テスト",
  ts: overrides.ts ?? "2024-03-22T21:38:31+09:00",
  logged_at: overrides.logged_at ?? "2024-03-22T21:40:00+09:00",
  meta: overrides.meta ?? { channel: "#dev" },
  detail: overrides.detail ?? {
    slack: { channel_id: "C123", channel_name: "dev", text: "hello" },
  },
});

describe("JsonlWriter", () => {
  it("events.jsonl を日付ディレクトリにappendする", async () => {
    const tmp = await mkdtemp(`${tmpdir()}/reaclog-jsonl-`);
    const writer = new JsonlWriter({ dataDir: tmp });

    const event1 = createEvent();
    const event2 = createEvent({
      uid: "slack:C123@1711112222.000300",
      ts: "2023-12-01T10:00:00+09:00",
      logged_at: "2024-03-23T08:00:00+09:00",
      subject: "テスト2",
    });

    await writer.append(event1);
    await writer.append(event2);

    const pathEvent1 = join(tmp, "2024", "03", "22", "slack", "events.jsonl");
    const pathEvent2 = join(tmp, "2024", "03", "23", "slack", "events.jsonl");

    const content1 = await readFile(pathEvent1, "utf8");
    const lines1 = content1.trim().split("\n");
    assert.equal(lines1.length, 1);
    assert.equal(JSON.parse(lines1[0]).uid, event1.uid);

    const content2 = await readFile(pathEvent2, "utf8");
    const lines2 = content2.trim().split("\n");
    assert.equal(lines2.length, 1);
    const parsed2 = JSON.parse(lines2[0]);
    assert.equal(parsed2.uid, event2.uid);

    await rm(tmp, { recursive: true, force: true });
  });

  it("logged_at が無い場合は現在時刻で補完する", async () => {
    const tmp = await mkdtemp(`${tmpdir()}/reaclog-jsonl-`);
    const writer = new JsonlWriter({ dataDir: tmp });

    const event = createEvent({ logged_at: undefined });

    await writer.append(event);

    assert.ok(event.logged_at && event.logged_at.length > 0, "logged_at should be set");

    const datePart = event.logged_at!.split("T")[0] ?? "1970-01-01";
    const [year, month, day] = datePart.split("-");
    const targetPath = join(tmp, year!, month!, day!, "slack", "events.jsonl");
    const content = await readFile(targetPath, "utf8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 1);
    await rm(tmp, { recursive: true, force: true });
  });
});
