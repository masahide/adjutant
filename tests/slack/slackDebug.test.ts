import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSlackDebugTargets,
  hasSlackDebugTarget,
  SlackDebug,
} from "../../src/slack/slackDebug.js";

describe("SlackDebug", () => {
  it("createSlackDebugTargets は空白込みの token を正規化する", () => {
    const targets = createSlackDebugTargets(" slack:fetch,slack:runtime:verbose ,, ");
    assert.equal(targets.has("slack:fetch"), true);
    assert.equal(targets.has("slack:runtime:verbose"), true);
    assert.equal(targets.has(""), false);
  });

  it("hasSlackDebugTarget はいずれか一致で true を返す", () => {
    const targets = new Set(["slack", "slack:fetch"]);
    assert.equal(hasSlackDebugTarget(targets, "slack:runtime", "slack:fetch"), true);
    assert.equal(hasSlackDebugTarget(targets, "slack:runtime"), false);
  });

  it("redactPayload は token/cookie をマスクする", () => {
    const debug = new SlackDebug({ prefix: "Test", enabled: true });
    const redacted = debug.redactPayload({
      token: "abc",
      session_cookie: "secret",
      text: "ok",
    });
    assert.deepEqual(redacted, {
      token: "[redacted]",
      session_cookie: "[redacted]",
      text: "ok",
    });
  });

  it("safePreview は bigint を文字列化する", () => {
    const debug = new SlackDebug({ prefix: "Test", enabled: true });
    const preview = debug.safePreview({ value: 123n }) as { value: string };
    assert.equal(preview.value, "123");
  });

  it("safePreview は stringify 不能なら元値を返す", () => {
    const debug = new SlackDebug({ prefix: "Test", enabled: true });
    const value: { self?: unknown } = {};
    value.self = value;
    const preview = debug.safePreview(value);
    assert.equal(preview, value);
  });
});
