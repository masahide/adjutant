import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as Registry from "../../src/assistant/idempotency-registry.js";

describe("IdempotencyRegistry", () => {
  beforeEach(() => {
    Registry.resetForTest();
  });

  it("新規キーは kind=new を返す", () => {
    const result = Registry.getOrCreate("main", "msg-001");
    assert.equal(result.kind, "new");
    assert.equal(result.runId, "main:msg-001");
  });

  it("TTL 内の再送は kind=existing を返す", () => {
    Registry.getOrCreate("main", "msg-001");
    const result = Registry.getOrCreate("main", "msg-001");
    assert.equal(result.kind, "existing");
    assert.equal(result.runId, "main:msg-001");
    if (result.kind === "existing") {
      assert.equal(result.status, "in_flight");
    }
  });

  it("updateStatus で状態更新後の再送は更新後ステータスを返す", () => {
    const created = Registry.getOrCreate("main", "msg-001");
    Registry.updateStatus(created.runId, "ok");
    const result = Registry.getOrCreate("main", "msg-001");
    assert.equal(result.kind, "existing");
    if (result.kind === "existing") {
      assert.equal(result.status, "ok");
    }
  });

  it("TTL 超過後は新規扱いになる", () => {
    Registry.getOrCreate("main", "msg-001", 0);
    const result = Registry.getOrCreate("main", "msg-001", 0);
    assert.equal(result.kind, "new");
  });

  it("異なる sessionKey は別エントリ", () => {
    const a = Registry.getOrCreate("session-a", "msg-001");
    const b = Registry.getOrCreate("session-b", "msg-001");
    assert.equal(b.kind, "new");
    assert.notEqual(a.runId, b.runId);
  });

  it("cleanup で TTL 切れエントリを削除", () => {
    Registry.getOrCreate("main", "msg-001", 1);
    const removed = Registry.cleanup(Date.now() + 2000, 1);
    assert.equal(removed, 1);
    const result = Registry.getOrCreate("main", "msg-001");
    assert.equal(result.kind, "new");
  });
});
