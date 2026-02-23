import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPathMapper } from "../../src/sandbox/path-mapper.js";

describe("sandbox path mapper", () => {
  const mapper = createPathMapper({
    hostWorkspaceDir: "/tmp/workspace",
    containerWorkdir: "/workspace",
  });

  it("ワークスペースルートは container workdir に変換する", () => {
    assert.equal(mapper.hostToContainer("/tmp/workspace"), "/workspace");
    assert.equal(mapper.hostToContainer(""), "/workspace");
  });

  it("ワークスペース配下は相対パスを維持して変換する", () => {
    assert.equal(mapper.hostToContainer("/tmp/workspace/src"), "/workspace/src");
    assert.equal(mapper.hostToContainer("/tmp/workspace/src/lib"), "/workspace/src/lib");
  });

  it("ワークスペース外パスは container workdir にフォールバックする", () => {
    assert.equal(mapper.hostToContainer("/tmp/other"), "/workspace");
    assert.equal(mapper.hostToContainer("../outside"), "/workspace");
  });
});
