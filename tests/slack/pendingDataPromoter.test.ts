import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { withJsonlChecksum } from "../../src/io/jsonl-checksum.js";
import { PendingDataPromoter } from "../../src/slack/pendingDataPromoter.js";

type JsonRecord = Record<string, unknown>;

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function toEvent(uid: string, workspaceKey: string, teamId: string): JsonRecord {
  return withJsonlChecksum({
    schema: "adjutant.event.v1.1",
    source: "slack",
    kind: "post",
    uid,
    ts: "2026-02-25T00:00:00Z",
    meta: {
      account_id: "_pending",
      workspace_key: workspaceKey,
      team_id: teamId,
    },
    detail: {
      slack: {
        channel_id: "C123",
        message_ts: "1740000000.000100",
      },
    },
  });
}

describe("PendingDataPromoter", () => {
  it("workspace/team 単位で _pending の events/cache/pins を昇格できる", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "adjutant-pending-promoter-"));

    try {
      const pendingEventsPath = join(
        dataDir,
        "accounts",
        "_pending",
        "2026",
        "02",
        "25",
        "slack",
        "events.jsonl"
      );
      await mkdir(dirname(pendingEventsPath), { recursive: true });
      const pendingLines = [
        JSON.stringify(toEvent("uid-promote", "acme", "T111")),
        JSON.stringify(toEvent("uid-keep", "other", "T222")),
        "{broken-json",
      ];
      await writeFile(pendingEventsPath, `${pendingLines.join("\n")}\n`, "utf8");

      const pendingCacheBase = join(dataDir, "accounts", "_pending", "_cache", "slack");
      await mkdir(join(pendingCacheBase, "channel-names-by-team"), { recursive: true });
      await mkdir(join(pendingCacheBase, "user-names-by-team"), { recursive: true });
      await writeFile(
        join(pendingCacheBase, "channel-names-by-team", "T111.json"),
        `${JSON.stringify(
          {
            schema: "adjutant.slack.channel-cache.v1",
            updated_at: "2026-02-25T00:00:00.000Z",
            team_id: "T111",
            channels: { C111: "general" },
          },
          null,
          2
        )}\n`,
        "utf8"
      );
      await writeFile(
        join(pendingCacheBase, "channel-names-by-team", "T222.json"),
        `${JSON.stringify(
          {
            schema: "adjutant.slack.channel-cache.v1",
            updated_at: "2026-02-25T00:00:00.000Z",
            team_id: "T222",
            channels: { C222: "random" },
          },
          null,
          2
        )}\n`,
        "utf8"
      );
      await writeFile(
        join(pendingCacheBase, "user-names-by-team", "T111.json"),
        `${JSON.stringify(
          {
            schema: "adjutant.slack.user-cache.v2",
            updated_at: "2026-02-25T00:00:00.000Z",
            team_id: "T111",
            users: {
              U111: {
                real_name: "Alice",
              },
            },
          },
          null,
          2
        )}\n`,
        "utf8"
      );
      await writeFile(
        join(pendingCacheBase, "workspace-route-pins.json"),
        `${JSON.stringify(
          {
            schema: "adjutant.slack.workspace-route-pin.v1",
            updatedAt: "2026-02-25T00:00:00.000Z",
            pins: [
              { workspaceKey: "acme", mode: "enterprise", decidedAt: 10 },
              { workspaceKey: "other", mode: "team", decidedAt: 20 },
            ],
          },
          null,
          2
        )}\n`,
        "utf8"
      );

      const promoter = new PendingDataPromoter({ dataDir });
      const result1 = await promoter.promoteByWorkspace({
        workspaceKey: "acme",
        accountId: "E999",
        teamId: "T111",
        aliases: ["acme", "T111", "E999"],
      });
      assert.equal(result1.movedEventLines, 1);
      assert.equal(result1.skippedEventLines, 1);
      assert.deepEqual(result1.movedChannelCacheTeams, ["T111"]);
      assert.deepEqual(result1.movedUserCacheTeams, ["T111"]);
      assert.deepEqual(result1.movedRoutePins, ["acme"]);

      const promotedEventsPath = join(
        dataDir,
        "accounts",
        "E999",
        "2026",
        "02",
        "25",
        "slack",
        "events.jsonl"
      );
      const promotedEvents = (await readFile(promotedEventsPath, "utf8")).trim().split("\n");
      const promoted = promotedEvents.map((line) => JSON.parse(line) as JsonRecord);
      assert.equal(promoted.length, 1);
      assert.equal(promoted[0]?.uid, "uid-promote");
      assert.equal((promoted[0]?.meta as JsonRecord | undefined)?.account_id, "E999");

      const pendingAfter = (await readFile(pendingEventsPath, "utf8")).trim().split("\n");
      assert.equal(pendingAfter.length, 2);
      assert.equal((JSON.parse(pendingAfter[0] ?? "{}") as JsonRecord).uid, "uid-keep");
      assert.equal(pendingAfter[1], "{broken-json");

      const promotedChannelPath = join(
        dataDir,
        "accounts",
        "E999",
        "_cache",
        "slack",
        "channel-names-by-team",
        "T111.json"
      );
      const promotedChannel = JSON.parse(await readFile(promotedChannelPath, "utf8")) as {
        channels?: Record<string, string>;
      };
      assert.equal(promotedChannel.channels?.C111, "general");
      assert.equal(
        await exists(join(pendingCacheBase, "channel-names-by-team", "T111.json")),
        false
      );
      assert.equal(
        await exists(join(pendingCacheBase, "channel-names-by-team", "T222.json")),
        true
      );

      const promotedPinsPath = join(
        dataDir,
        "accounts",
        "E999",
        "_cache",
        "slack",
        "workspace-route-pins.json"
      );
      const promotedPins = JSON.parse(await readFile(promotedPinsPath, "utf8")) as {
        pins?: Array<{ workspaceKey?: string }>;
      };
      assert.deepEqual(
        (promotedPins.pins ?? []).map((pin) => pin.workspaceKey),
        ["acme"]
      );
      const pendingPins = JSON.parse(
        await readFile(join(pendingCacheBase, "workspace-route-pins.json"), "utf8")
      ) as { pins?: Array<{ workspaceKey?: string }> };
      assert.deepEqual(
        (pendingPins.pins ?? []).map((pin) => pin.workspaceKey),
        ["other"]
      );

      const result2 = await promoter.promoteByWorkspace({
        workspaceKey: "acme",
        accountId: "E999",
        teamId: "T111",
        aliases: ["acme", "T111", "E999"],
      });
      assert.equal(result2.movedEventLines, 0);
      const promotedAgain = (await readFile(promotedEventsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as JsonRecord)
        .filter((record) => record.uid === "uid-promote");
      assert.equal(promotedAgain.length, 1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
