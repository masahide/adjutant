import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RuntimeContextRegistry } from "../../src/slack/runtimeContextRegistry.js";

describe("RuntimeContextRegistry", () => {
  it("frame指定時は default->isolated->other->global default->null の順で返す", () => {
    const registry = new RuntimeContextRegistry();

    registry.onCreated({
      context: { id: 1, name: "default-main", auxData: { frameId: "F1", type: "default" } },
    });
    registry.onCreated({
      context: { id: 2, name: "isolated-main", auxData: { frameId: "F1", type: "isolated" } },
    });
    registry.onCreated({
      context: { id: 3, name: "other-main", auxData: { frameId: "F1", type: "worker" } },
    });
    registry.onCreated({
      context: { id: 9, name: "default-fallback", auxData: { type: "default" } },
    });

    assert.deepEqual(registry.resolveContextIds("F1"), [1, 2, 3, 9, null]);
  });

  it("destroy 後は対象 context が解決候補から除外される", () => {
    const registry = new RuntimeContextRegistry();

    registry.onCreated({
      context: { id: 11, name: "default-main", auxData: { frameId: "F1", isDefault: true } },
    });
    registry.onCreated({
      context: { id: 12, name: "other-main", auxData: { frameId: "F1", type: "worker" } },
    });

    registry.onDestroyed({ executionContextId: 11 });
    registry.onDestroyed({ executionContextId: 12 });

    assert.deepEqual(registry.resolveContextIds("F1"), [null]);
  });
});
