import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { withJsonlChecksum } from "../../src/io/jsonl-checksum.js";
import { recoverJsonlFile, scanJsonlFile } from "../../src/io/jsonl-recovery.js";

describe("jsonl-recovery", () => {
  it("末尾 partial line を truncate で復旧する", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-jsonl-recovery-`);
    const filePath = join(dir, "timeline.jsonl");
    try {
      const line1 = JSON.stringify(withJsonlChecksum({ uid: "u1", ts: "2026-02-21T00:00:00Z" }));
      await writeFile(filePath, `${line1}\n{"uid":"broken"`, "utf8");

      const before = await scanJsonlFile(filePath);
      assert.equal(before.valid, false);
      assert.equal(before.reason, "partial-tail");

      const recovered = await recoverJsonlFile(filePath);
      assert.equal(recovered.repaired, true);

      const afterRaw = await readFile(filePath, "utf8");
      const lines = afterRaw.trim().split("\n");
      assert.equal(lines.length, 1);
      assert.equal(JSON.parse(lines[0]).uid, "u1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("checksum mismatch を破損として検知する", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-jsonl-recovery-`);
    const filePath = join(dir, "timeline.jsonl");
    try {
      const valid = JSON.stringify(withJsonlChecksum({ uid: "u1", ts: "2026-02-21T00:00:00Z" }));
      const broken = JSON.stringify({
        uid: "u2",
        ts: "2026-02-21T00:01:00Z",
        checksum: "not-valid",
      });
      await writeFile(filePath, `${valid}\n${broken}\n`, "utf8");

      const scan = await scanJsonlFile(filePath);
      assert.equal(scan.valid, false);
      assert.equal(scan.reason, "checksum-mismatch");

      await recoverJsonlFile(filePath);
      const after = await readFile(filePath, "utf8");
      const lines = after.trim().split("\n");
      assert.equal(lines.length, 1);
      assert.equal(JSON.parse(lines[0]).uid, "u1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
