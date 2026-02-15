import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionEntryStore } from "../../src/assistant/session-entry-store.js";

let tempDirs: string[] = [];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("SessionEntryStore", () => {
  afterEach(async () => {
    for (const tempDir of tempDirs) {
      await rm(tempDir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it("破損した JSON は .broken-* へ退避して空ストアで復旧する", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-session-store-`);
    tempDirs.push(tempDir);
    const sessionsPath = join(tempDir, "sessions.json");
    await writeFile(sessionsPath, "{ not-json", "utf8");

    const result = await readSessionEntryStore(sessionsPath);

    assert.equal(result.path, sessionsPath);
    assert.deepEqual(result.store, {});
    assert.equal(await exists(sessionsPath), false);

    const files = await readdir(tempDir);
    const backup = files.find((name) => name.startsWith("sessions.json.broken-"));
    assert.equal(typeof backup, "string");
  });

  it("ルートが object 以外の場合も .broken-* へ退避する", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-session-store-`);
    tempDirs.push(tempDir);
    const sessionsPath = join(tempDir, "sessions.json");
    await writeFile(sessionsPath, "[]", "utf8");

    const result = await readSessionEntryStore(sessionsPath);

    assert.deepEqual(result.store, {});
    assert.equal(await exists(sessionsPath), false);
    const files = await readdir(tempDir);
    assert.equal(
      files.some((name) => name.startsWith("sessions.json.broken-")),
      true
    );
  });
});
