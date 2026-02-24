import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TOOL_HUB_ERROR_CODES,
  TOOL_HUB_MODES,
  type ToolHubError,
  type ToolHubSuccess,
} from "../../../src/assistant/dynamic-tool/index.js";

describe("dynamic-tool types", () => {
  it("ToolHubMode の候補が契約通りである", () => {
    assert.deepEqual(TOOL_HUB_MODES, ["catalog", "provider_help", "action_help", "execute"]);
  });

  it("ToolHubErrorCode の候補が契約通りである", () => {
    assert.deepEqual(TOOL_HUB_ERROR_CODES, [
      "unknown_provider",
      "unknown_action",
      "validation_error",
      "execution_error",
    ]);
  });

  it("成功/失敗レスポンス型の外形を満たす値を扱える", () => {
    const success: ToolHubSuccess = {
      ok: true,
      mode: "catalog",
      data: { providers: ["slack"] },
    };
    const failure: ToolHubError = {
      ok: false,
      code: "unknown_provider",
      message: "provider not found",
    };

    assert.equal(success.ok, true);
    assert.equal(failure.ok, false);
  });
});
