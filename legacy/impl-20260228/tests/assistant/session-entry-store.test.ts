import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSessionEntryStore,
  writeSessionEntryStore,
} from "../../src/assistant/session-entry-store.js";

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

  it("writeSessionEntryStore は tmp を残さず原子的に保存する", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-session-store-`);
    tempDirs.push(tempDir);
    const sessionsPath = join(tempDir, "sessions.json");
    await writeFile(sessionsPath, JSON.stringify({ main: { sessionId: "before" } }), "utf8");

    await writeSessionEntryStore(
      {
        main: { sessionId: "after", updatedAt: "2026-02-15T00:00:00.000Z" },
      },
      sessionsPath
    );

    const saved = JSON.parse(await readFile(sessionsPath, "utf8")) as {
      main?: { sessionId?: string; updatedAt?: string };
    };
    assert.equal(saved.main?.sessionId, "after");
    assert.equal(saved.main?.updatedAt, "2026-02-15T00:00:00.000Z");

    const files = await readdir(tempDir);
    assert.equal(
      files.some((name) => name.includes(".tmp-")),
      false
    );
  });
});
