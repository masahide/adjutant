import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../../src/assistant/event-reader.js";
import type { NormalizedEvent } from "../../src/core/events.js";

function createEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    schema: "adjutant.event.v1.1",
    uid: overrides.uid ?? "slack:C100@1",
    source: "slack",
    kind: overrides.kind ?? "post",
    actor: overrides.actor ?? "alice",
    subject: overrides.subject ?? "hello",
    ts: overrides.ts ?? new Date().toISOString(),
    logged_at: overrides.logged_at ?? new Date().toISOString(),
    detail:
      overrides.detail ??
      ({
        slack: {
          channel_id: "C100",
          text: "hello",
        },
      } as NormalizedEvent["detail"]),
  };
}

async function writeEventsFile(params: {
  dataDir: string;
  accountId?: string;
  date: string;
  lines: string[];
}): Promise<string> {
  const [year, month, day] = params.date.split("-");
  const accountId = params.accountId ?? "default";
  const dir = join(
    params.dataDir,
    "accounts",
    accountId,
    year ?? "1970",
    month ?? "01",
    day ?? "01",
    "slack"
  );
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "events.jsonl");
  await writeFile(filePath, `${params.lines.join("\n")}\n`, "utf8");
  return filePath;
}

describe("EventReader", () => {
  it("ファイル不在時は空配列を返す", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-event-reader-`);
    try {
      const result = await readEvents({
        dataDir: tempDir,
        date: "2026-02-15",
      });
      assert.deepEqual(result, []);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("date 指定した events.jsonl をパースする", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-event-reader-`);
    try {
      const date = "2026-02-15";
      const event = createEvent({
        uid: "slack:C100@2",
        ts: "2026-02-15T10:00:00.000Z",
      });
      await writeEventsFile({
        dataDir: tempDir,
        date,
        lines: [JSON.stringify(event), "{broken-json"],
      });

      const result = await readEvents({
        dataDir: tempDir,
        date,
        sinceMinutes: 60 * 24 * 365,
      });
      assert.equal(result.length, 1);
      assert.equal(result[0]?.uid, "slack:C100@2");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("sinceMinutes と limit で新しい順に切り詰める", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-event-reader-`);
    try {
      const now = Date.now();
      const date = new Date(now).toISOString().slice(0, 10);
      const old = createEvent({
        uid: "old",
        ts: new Date(now - 30 * 60_000).toISOString(),
      });
      const middle = createEvent({
        uid: "middle",
        ts: new Date(now - 5 * 60_000).toISOString(),
      });
      const newest = createEvent({
        uid: "newest",
        ts: new Date(now - 60_000).toISOString(),
      });
      await writeEventsFile({
        dataDir: tempDir,
        date,
        lines: [JSON.stringify(old), JSON.stringify(middle), JSON.stringify(newest)],
      });

      const result = await readEvents({
        dataDir: tempDir,
        date,
        sinceMinutes: 10,
        limit: 2,
      });

      assert.deepEqual(
        result.map((event) => event.uid),
        ["newest", "middle"]
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("kinds と channels で絞り込みできる", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-event-reader-`);
    try {
      const now = Date.now();
      const date = new Date(now).toISOString().slice(0, 10);
      const post = createEvent({
        uid: "post-1",
        kind: "post",
        ts: new Date(now - 2_000).toISOString(),
        detail: {
          slack: {
            channel_id: "C-target",
            text: "target",
          },
        },
      });
      const reaction = createEvent({
        uid: "reaction-1",
        kind: "reaction",
        ts: new Date(now - 1_000).toISOString(),
        detail: {
          slack: {
            channel_id: "C-target",
            message_ts: "1",
          },
        },
      });
      const otherChannel = createEvent({
        uid: "post-2",
        kind: "post",
        ts: new Date(now - 500).toISOString(),
        detail: {
          slack: {
            channel_id: "C-other",
            text: "other",
          },
        },
      });

      await writeEventsFile({
        dataDir: tempDir,
        date,
        lines: [JSON.stringify(post), JSON.stringify(reaction), JSON.stringify(otherChannel)],
      });

      const result = await readEvents({
        dataDir: tempDir,
        date,
        sinceMinutes: 10,
        kinds: ["post"],
        channels: ["C-target"],
      });

      assert.equal(result.length, 1);
      assert.equal(result[0]?.uid, "post-1");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("accountId 指定時は対象 account 配下のみを読む", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-event-reader-`);
    try {
      const date = "2026-02-15";
      const workEvent = createEvent({
        uid: "work-event",
        ts: "2026-02-15T10:00:00.000Z",
      });
      const privateEvent = createEvent({
        uid: "private-event",
        ts: "2026-02-15T11:00:00.000Z",
      });
      await writeEventsFile({
        dataDir: tempDir,
        accountId: "work",
        date,
        lines: [JSON.stringify(workEvent)],
      });
      await writeEventsFile({
        dataDir: tempDir,
        accountId: "private",
        date,
        lines: [JSON.stringify(privateEvent)],
      });

      const result = await readEvents({
        dataDir: tempDir,
        accountId: "work",
        date,
        sinceMinutes: 60 * 24 * 365,
      });

      assert.equal(result.length, 1);
      assert.equal(result[0]?.uid, "work-event");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("date 未指定 + sinceMinutes が日跨ぎの場合は前日ファイルも読む", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-event-reader-`);
    const originalNow = Date.now;
    try {
      const frozenNow = Date.parse("2026-02-15T00:10:00.000Z");
      Date.now = () => frozenNow;

      const prevEvent = createEvent({
        uid: "prev-day-window",
        ts: "2026-02-14T23:55:00.000Z",
      });
      const todayEvent = createEvent({
        uid: "today-window",
        ts: "2026-02-15T00:05:00.000Z",
      });
      await writeEventsFile({
        dataDir: tempDir,
        date: "2026-02-14",
        lines: [JSON.stringify(prevEvent)],
      });
      await writeEventsFile({
        dataDir: tempDir,
        date: "2026-02-15",
        lines: [JSON.stringify(todayEvent)],
      });

      const result = await readEvents({
        dataDir: tempDir,
        sinceMinutes: 30,
        timezone: "UTC",
      });

      assert.deepEqual(
        result.map((event) => event.uid),
        ["today-window", "prev-day-window"]
      );
    } finally {
      Date.now = originalNow;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("timezone 基準で当日ディレクトリを解決し、最新イベントを取りこぼさない", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-event-reader-`);
    const originalNow = Date.now;
    try {
      const frozenNow = Date.parse("2026-02-14T15:10:00.000Z");
      Date.now = () => frozenNow;

      const jstLatest = createEvent({
        uid: "jst-latest",
        ts: "2026-02-14T15:05:00.000Z",
        logged_at: "2026-02-15T00:05:00+09:00",
      });
      await writeEventsFile({
        dataDir: tempDir,
        date: "2026-02-15",
        lines: [JSON.stringify(jstLatest)],
      });

      const result = await readEvents({
        dataDir: tempDir,
        sinceMinutes: 30,
        timezone: "Asia/Tokyo",
      });

      assert.deepEqual(
        result.map((event) => event.uid),
        ["jst-latest"]
      );
    } finally {
      Date.now = originalNow;
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
