import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ResponseBodyReader } from "../../src/slack/responseBodyReader.js";

describe("ResponseBodyReader", () => {
  it("base64レスポンスをデコードできる", async () => {
    const reader = new ResponseBodyReader({
      Network: {
        getResponseBody: async () => ({
          base64Encoded: true,
          body: Buffer.from('{"ok":true}', "utf8").toString("base64"),
        }),
      },
    });

    const text = await reader.readText("req-1");
    assert.equal(text.unavailable, false);
    assert.equal(text.text, '{"ok":true}');

    const json = await reader.readJson("req-1");
    assert.equal(json.unavailable, false);
    assert.equal(json.invalidJson, false);
    assert.deepEqual(json.data, { ok: true });
  });

  it("JSON parseエラー時はinvalidJson=trueを返す", async () => {
    const reader = new ResponseBodyReader({
      Network: {
        getResponseBody: async () => ({ base64Encoded: false, body: "not-json" }),
      },
    });

    const json = await reader.readJson("req-2");
    assert.equal(json.unavailable, false);
    assert.equal(json.invalidJson, true);
    assert.equal(json.data, null);
  });

  it("getResponseBody失敗時はunavailable=trueを返す", async () => {
    const reader = new ResponseBodyReader({
      Network: {
        getResponseBody: async () => {
          throw new Error("boom");
        },
      },
    });

    const text = await reader.readText("req-3");
    assert.equal(text.unavailable, true);
    assert.equal(text.text, null);
  });
});
