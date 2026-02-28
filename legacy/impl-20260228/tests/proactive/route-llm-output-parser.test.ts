import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRouteDecisionFromOpenAiCompletion } from "../../src/proactive/route-llm-output-parser.js";

describe("route-llm-output-parser", () => {
  it("message.content の JSON から判定を抽出できる", () => {
    const decision = parseRouteDecisionFromOpenAiCompletion({
      choices: [{ message: { content: '{"outcome":"run","confidence":0.9}' } }],
    });

    assert.equal(decision.outcome, "run");
    assert.equal(decision.confidence, 0.9);
  });

  it("message.tool_calls.function.arguments を優先して判定できる", () => {
    const decision = parseRouteDecisionFromOpenAiCompletion({
      choices: [
        {
          message: {
            content: '{"outcome":"pending","confidence":0.1}',
            tool_calls: [
              {
                function: {
                  arguments: '{"outcome":"run","confidence":0.75,"reason":"urgent"}',
                },
              },
            ],
          },
        },
      ],
    });

    assert.equal(decision.outcome, "run");
    assert.equal(decision.reason, "urgent");
  });

  it("空レスポンスは route-llm-empty-response として扱う", () => {
    assert.throws(
      () => parseRouteDecisionFromOpenAiCompletion({ choices: [{ message: { content: "" } }] }),
      /route-llm-empty-response/
    );
  });

  it("不正JSONは route-llm-invalid-json として扱う", () => {
    assert.throws(
      () =>
        parseRouteDecisionFromOpenAiCompletion({
          choices: [{ message: { content: '{"outcome":"run"' } }],
        }),
      /route-llm-invalid-json/
    );
  });
});
