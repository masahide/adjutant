import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeSlackParsedPayload,
  parseSlackRequestBody,
} from "../../src/slack/slackIngressRequestParser.js";

describe("parseSlackRequestBody", () => {
  it("multipart/form-data の token と payload JSON を解析できる", () => {
    const boundary = "----WebKitFormBoundaryabc123";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="token"',
      "",
      "xoxc-test-token",
      `--${boundary}`,
      'Content-Disposition: form-data; name="payload"',
      "",
      '{"user":"U123","channel":"C123","message":"ok"}',
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const parsed = parseSlackRequestBody(body, `multipart/form-data; boundary=${boundary}`);

    assert.deepEqual(parsed, {
      token: "xoxc-test-token",
      payload: '{"user":"U123","channel":"C123","message":"ok"}',
      user: "U123",
      channel: "C123",
      message: "ok",
    });
  });

  it("text/plain + JSON body を解析できる", () => {
    const body = JSON.stringify({
      token: "xoxc-token",
      user_id: "U999",
      channel_id: "C999",
    });
    const parsed = parseSlackRequestBody(body, "text/plain; charset=utf-8");
    assert.deepEqual(parsed, {
      token: "xoxc-token",
      user_id: "U999",
      channel_id: "C999",
    });
  });
});

describe("normalizeSlackParsedPayload", () => {
  it("JSON 文字列キーを object に正規化できる", () => {
    const normalized = normalizeSlackParsedPayload({
      item: '{"channel":"C777","ts":"1.23"}',
      metadata: '{"a":1}',
      text: "plain",
    });

    assert.deepEqual(normalized, {
      item: { channel: "C777", ts: "1.23" },
      metadata: { a: 1 },
      text: "plain",
    });
  });
});
