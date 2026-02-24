import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SlackAuthProvider } from "../../../src/assistant/slack-api-tools/index.js";

describe("SlackAuthProvider", () => {
  it("xoxd が無い場合は auth_invalid になる", () => {
    const provider = new SlackAuthProvider({
      xoxcToken: "xoxc-111",
      xoxdToken: "",
    });

    const validation = provider.validate();
    assert.deepEqual(validation, {
      ok: false,
      code: "auth_invalid",
      message: "xoxc/xoxd token is required",
      primaryError: undefined,
      fallbackError: undefined,
    });
    assert.equal(provider.resolve(), null);
  });

  it("xoxc/xoxd が揃っていれば Authorization/Cookie を構成できる", () => {
    const provider = new SlackAuthProvider({
      xoxcToken: "xoxc-123",
      xoxdToken: "xoxd-456",
      userAgent: "adjutant-test",
      acceptLanguage: "ja-JP",
    });

    assert.equal(provider.validate(), null);
    const resolved = provider.resolve();
    assert.ok(resolved);
    assert.equal(resolved?.defaultHeaders.Authorization, "Bearer xoxc-123");
    assert.equal(resolved?.defaultHeaders.Cookie, "d=xoxd-456");
    assert.equal(resolved?.defaultHeaders["User-Agent"], "adjutant-test");
    assert.equal(resolved?.defaultHeaders["Accept-Language"], "ja-JP");
  });

  it("env未設定時は tokenStateProvider から補完する", () => {
    const provider = new SlackAuthProvider({
      tokenStateProvider: () => ({
        xoxcToken: "xoxc-from-cache",
        xoxdToken: "xoxd-from-cache",
      }),
    });

    assert.equal(provider.validate(), null);
    const resolved = provider.resolve();
    assert.ok(resolved);
    assert.equal(resolved?.defaultHeaders.Authorization, "Bearer xoxc-from-cache");
    assert.equal(resolved?.defaultHeaders.Cookie, "d=xoxd-from-cache");
  });
});
