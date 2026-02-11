import assert from "node:assert/strict";
import vm from "node:vm";
import { describe, it } from "node:test";
import { buildDomCaptureExpression } from "../../src/slack/domCaptureScript.js";

const buildInput = (tsList: string[]) => ({
  tsList,
  selectors: {
    root: [],
    body: [],
    channel: [],
  },
  debugMode: false,
});

describe("buildDomCaptureExpression", () => {
  it("Runtime.evaluate で実行可能な式を返す", () => {
    const expression = buildDomCaptureExpression(buildInput([]));
    const value = vm.runInNewContext(expression, {
      document: {
        querySelectorAll: () => [],
        querySelector: () => null,
      },
    }) as { status?: string };

    assert.equal(value.status, "no-ts");
  });

  it("core 関数を埋め込んだ式を生成する", () => {
    const expression = buildDomCaptureExpression(buildInput(["1711112222.000100"]));
    assert.match(expression, /captureDomSnapshot/);
    assert.match(expression, /1711112222\.000100/);
  });
});
