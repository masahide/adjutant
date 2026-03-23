import assert from "node:assert/strict";
import test from "node:test";

import { createThreadTitleGenerator } from "../../../../src/control-plane/http/thread-title-generator.js";

test("ThreadTitleGenerator は apiKey 未設定時に fallback title を返す", async () => {
  const generator = createThreadTitleGenerator();

  const result = await generator({
    messages: ["Slack の通知 triage UI の archive 復元導線を設計したい"],
  });

  assert.equal(result.model, "gpt-5.4-nano");
  assert.equal(result.fallback, true);
  assert.equal(result.title, "Slack の通知 triage UI の archive 復元導線を設計したい");
});

test("ThreadTitleGenerator は gpt-5.4-nano を使ってタイトルを生成する", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const generator = createThreadTitleGenerator({
    apiKey: "test-key",
    client: {
      create: async (input) => {
        calls.push(input as Record<string, unknown>);
        return {
          output_text: '"Archive UI cleanup"',
        };
      },
    },
  });

  const result = await generator({
    messages: ["Archive 済み thread を安全に戻したい", "main は archive 不可にしたい"],
  });

  assert.equal(result.title, "Archive UI cleanup");
  assert.equal(result.model, "gpt-5.4-nano");
  assert.equal(result.fallback, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.model, "gpt-5.4-nano");
});
