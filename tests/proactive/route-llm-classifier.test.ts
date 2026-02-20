import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createOpenAiSecondaryClassifier,
  resolveRouteLlmRuntimeConfig,
} from "../../src/proactive/route-llm-classifier.js";
import type { SecondaryClassifierInput } from "../../src/proactive/trigger-filter.js";

function createInput(uid: string): SecondaryClassifierInput {
  return {
    event: {
      schema: "adjutant.event.v1.1",
      uid,
      source: "slack",
      kind: "post",
      ts: "2026-02-20T00:00:00.000Z",
      actor: "U100",
      detail: {
        slack: {
          channel_id: "C100",
          message_ts: "1740000000.000100",
          text: "Can you check this issue quickly?",
        },
      },
    },
    selfState: "non-self",
    eventKind: "post",
    primaryOutcome: "run",
  };
}

describe("route-llm-classifier", () => {
  it("OpenAI 応答の outcome を run/pending へ正規化する", async () => {
    const audits: string[] = [];
    const classifier = createOpenAiSecondaryClassifier({
      model: "gpt-5-mini",
      maxConcurrent: 1,
      client: {
        chat: {
          completions: {
            create: async () => ({
              choices: [{ message: { content: '{"outcome":"pending","confidence":0.88}' } }],
            }),
          },
        },
      },
      onAudit: (log) => {
        audits.push(log.event);
      },
    });

    const outcome = await classifier(createInput("uid-1"));
    assert.equal(outcome, "pending");
    assert.deepEqual(audits, ["route-llm-decision"]);
  });

  it("不正なJSON応答は例外として扱う", async () => {
    const classifier = createOpenAiSecondaryClassifier({
      model: "gpt-5-mini",
      maxConcurrent: 1,
      client: {
        chat: {
          completions: {
            create: async () => ({
              choices: [{ message: { content: '{"outcome":"later"}' } }],
            }),
          },
        },
      },
    });

    await assert.rejects(classifier(createInput("uid-2")), /route-llm-invalid-outcome/);
  });

  it("maxConcurrent=1 では判定が逐次実行される", async () => {
    let active = 0;
    let maxActive = 0;
    const classifier = createOpenAiSecondaryClassifier({
      model: "gpt-5-mini",
      maxConcurrent: 1,
      client: {
        chat: {
          completions: {
            create: async () => {
              active += 1;
              maxActive = Math.max(maxActive, active);
              await new Promise((resolve) => setTimeout(resolve, 20));
              active -= 1;
              return {
                choices: [{ message: { content: '{"outcome":"run","confidence":0.77}' } }],
              };
            },
          },
        },
      },
    });

    const outcomes = await Promise.all([
      classifier(createInput("uid-3")),
      classifier(createInput("uid-4")),
      classifier(createInput("uid-5")),
    ]);

    assert.deepEqual(outcomes, ["run", "run", "run"]);
    assert.equal(maxActive, 1);
  });

  it("環境変数から route LLM 設定を解決できる", () => {
    const config = resolveRouteLlmRuntimeConfig({
      ADJUTANT_ROUTE_LLM_ENABLED: "true",
      ADJUTANT_ROUTE_LLM_MODEL: "gpt-4.1-mini",
      ADJUTANT_ROUTE_LLM_TIMEOUT_MS: "1500",
      ADJUTANT_ROUTE_LLM_MAX_CONCURRENT: "1",
    } as NodeJS.ProcessEnv);

    assert.equal(config.enabled, true);
    assert.equal(config.model, "gpt-4.1-mini");
    assert.equal(config.routeLlmTimeoutMs, 1500);
    assert.equal(config.maxConcurrentRouteLlm, 1);
  });
});
