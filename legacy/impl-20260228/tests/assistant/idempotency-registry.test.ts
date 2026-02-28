import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Registry from "../../src/assistant/idempotency-registry.js";

const fp = (value: string) => `fp-${value}`;

describe("IdempotencyRegistry", () => {
  beforeEach(() => {
    Registry.resetForTest();
  });

  it("新規キーは kind=new を返す", () => {
    const result = Registry.getOrCreate("main", "msg-001", fp("a"));
    assert.equal(result.kind, "new");
    assert.equal(result.runId, "msg-001");
    assert.equal(result.storeKey, "main:msg-001");
  });

  it("TTL 内の再送は kind=existing を返す", () => {
    Registry.getOrCreate("main", "msg-001", fp("a"));
    const result = Registry.getOrCreate("main", "msg-001", fp("a"));
    assert.equal(result.kind, "existing");
    assert.equal(result.runId, "msg-001");
    assert.equal(result.storeKey, "main:msg-001");
    if (result.kind === "existing") {
      assert.equal(result.status, "in_flight");
    }
  });

  it("updateStatus で状態更新後の再送は更新後ステータスを返す", () => {
    const created = Registry.getOrCreate("main", "msg-001", fp("a"));
    Registry.updateStatus(created.storeKey, "ok");
    const result = Registry.getOrCreate("main", "msg-001", fp("a"));
    assert.equal(result.kind, "existing");
    if (result.kind === "existing") {
      assert.equal(result.status, "ok");
    }
  });

  it("TTL 超過後は新規扱いになる", () => {
    let now = 1000;
    Registry.configureRegistry({ now: () => now });
    Registry.getOrCreate("main", "msg-001", fp("a"), 1);
    now += 1500;
    const result = Registry.getOrCreate("main", "msg-001", fp("a"), 1);
    assert.equal(result.kind, "new");
  });

  it("異なる sessionKey は別エントリ", () => {
    const a = Registry.getOrCreate("session-a", "msg-001", fp("a"));
    const b = Registry.getOrCreate("session-b", "msg-001", fp("a"));
    assert.equal(b.kind, "new");
    assert.equal(a.runId, b.runId); // runId = idempotencyKey なので同じ
    assert.notEqual(a.storeKey, b.storeKey); // storeKey は異なる
  });

  it("cleanup で TTL 切れエントリを削除", () => {
    Registry.getOrCreate("main", "msg-001", fp("a"), 1);
    const removed = Registry.cleanup(Date.now() + 2000, 1);
    assert.equal(removed, 1);
    const result = Registry.getOrCreate("main", "msg-001", fp("a"));
    assert.equal(result.kind, "new");
  });

  it("fingerprint 不一致は conflict を返す", () => {
    Registry.getOrCreate("main", "msg-001", fp("a"));
    const result = Registry.getOrCreate("main", "msg-001", fp("b"));
    assert.equal(result.kind, "conflict");
  });

  it("storePath を設定すると再起動後も復元できる", async () => {
    const tmp = await mkdtemp(`${tmpdir()}/adjutant-idempotency-`);
    const storePath = join(tmp, "memory", "idempotency.jsonl");
    try {
      Registry.configureRegistry({ storePath });
      const created = Registry.getOrCreate("main", "msg-001", fp("a"));
      Registry.updateStatus(created.storeKey, "ok");

      Registry.resetForTest();
      Registry.configureRegistry({ storePath });
      const restored = Registry.loadFromStore();
      assert.equal(restored > 0, true);

      const result = Registry.getOrCreate("main", "msg-001", fp("a"));
      assert.equal(result.kind, "existing");
      if (result.kind === "existing") {
        assert.equal(result.status, "ok");
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("maxEntries 超過時は古いキーを eviction する", () => {
    let now = 1000;
    Registry.configureRegistry({ now: () => now, maxEntries: 100 });

    for (let i = 0; i < 101; i += 1) {
      Registry.getOrCreate("main", `msg-${i}`, fp(String(i)));
      now += 1;
    }

    const oldest = Registry.getOrCreate("main", "msg-0", fp("0"));
    assert.equal(oldest.kind, "new");
  });

  it("ストア破損時 fail-open では起動継続できる", async () => {
    const tmp = await mkdtemp(`${tmpdir()}/adjutant-idempotency-`);
    const storePath = join(tmp, "memory", "idempotency.jsonl");
    try {
      await writeMalformedStore(storePath);
      Registry.configureRegistry({ storePath, storeFailureMode: "open" });
      assert.doesNotThrow(() => Registry.loadFromStore());
      const result = Registry.getOrCreate("main", "msg-001", fp("a"));
      assert.equal(result.kind, "new");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("ストア破損時 fail-closed では起動失敗する", async () => {
    const tmp = await mkdtemp(`${tmpdir()}/adjutant-idempotency-`);
    const storePath = join(tmp, "memory", "idempotency.jsonl");
    try {
      await writeMalformedStore(storePath);
      Registry.configureRegistry({ storePath, storeFailureMode: "closed" });
      assert.throws(() => Registry.loadFromStore(), /failed to load/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

async function writeMalformedStore(storePath: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, '{"bad":\n', "utf8");
}
