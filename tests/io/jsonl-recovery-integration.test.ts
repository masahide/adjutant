import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { withJsonlChecksum } from "../../src/io/jsonl-checksum.js";
import { recoverJsonlFiles } from "../../src/io/jsonl-recovery.js";

describe("jsonl-recovery integration", () => {
  it("events/timeline/session の3系統をまとめて復旧できる", async () => {
    const root = await mkdtemp(`${tmpdir()}/adjutant-jsonl-recovery-int-`);
    try {
      const eventsPath = join(root, "data", "2026", "02", "21", "slack", "events.jsonl");
      const timelinePath = join(root, "memory", "timeline.jsonl");
      const sessionPath = join(root, "memory", "sessions", "main.jsonl");
      await mkdir(dirname(eventsPath), { recursive: true });
      await mkdir(dirname(timelinePath), { recursive: true });
      await mkdir(dirname(sessionPath), { recursive: true });

      await writeFile(
        eventsPath,
        `${JSON.stringify(withJsonlChecksum({ uid: "e1", ts: "2026-02-21T00:00:00Z" }))}\n{"bad":\n`,
        "utf8"
      );
      await writeFile(
        timelinePath,
        `${JSON.stringify(withJsonlChecksum({ uid: "t1", ts: "2026-02-21T00:00:00Z" }))}\n{"bad":\n`,
        "utf8"
      );
      await writeFile(
        sessionPath,
        `${JSON.stringify(
          withJsonlChecksum({
            uid: "s1",
            ts: "2026-02-21T00:00:00Z",
            sessionKey: "main",
          })
        )}\n{"bad":\n`,
        "utf8"
      );

      const results = await recoverJsonlFiles([eventsPath, timelinePath, sessionPath]);
      assert.equal(results.length, 3);
      assert.equal(
        results.every((item) => item.repaired),
        true
      );

      const eventsAfter = await readFile(eventsPath, "utf8");
      const timelineAfter = await readFile(timelinePath, "utf8");
      const sessionAfter = await readFile(sessionPath, "utf8");
      assert.equal(eventsAfter.trim().split("\n").length, 1);
      assert.equal(timelineAfter.trim().split("\n").length, 1);
      assert.equal(sessionAfter.trim().split("\n").length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
