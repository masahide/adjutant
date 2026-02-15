import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEventContext } from "../../src/assistant/context-builder.js";
import type { NormalizedEvent } from "../../src/core/events.js";
import type { SessionTranscriptEvent } from "../../src/assistant/types.js";

function createEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    schema: "adjutant.event.v1.1",
    uid: overrides.uid ?? "uid-1",
    source: "slack",
    kind: overrides.kind ?? "post",
    actor: overrides.actor ?? "alice",
    subject: overrides.subject ?? "subject",
    ts: overrides.ts ?? "2026-02-15T10:00:00.000Z",
    detail:
      overrides.detail ??
      ({
        slack: {
          channel_id: "C123",
          text: "hello from channel",
        },
      } as NormalizedEvent["detail"]),
  };
}

const transcriptEvent: SessionTranscriptEvent = {
  sessionKey: "main",
  sessionId: "session-1",
  ts: Date.parse("2026-02-15T10:01:00.000Z"),
  role: "user",
  text: "直近の会話です",
  raw: {
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: "直近の会話です" }],
    },
  },
};

describe("ContextBuilder", () => {
  it("イベント配列をプロンプトテキストへ変換する", () => {
    const result = buildEventContext({
      events: [createEvent()],
    });

    assert.equal(result.eventCount, 1);
    assert.equal(result.truncated, false);
    assert.ok(result.text.includes("## Recent Slack Events"));
    assert.ok(result.text.includes("alice"));
    assert.ok(result.text.includes("hello from channel"));
  });

  it("メモリを注入できる", () => {
    const result = buildEventContext({
      events: [],
      memoryContent: "long-term-memory",
      dailyMemoryContent: "daily-memory",
      yesterdayMemoryContent: "yesterday-memory",
    });

    assert.ok(result.text.includes("Long-term Memory"));
    assert.ok(result.text.includes("daily-memory"));
    assert.ok(result.text.includes("yesterday-memory"));
  });

  it("SystemEvent を注入できる", () => {
    const result = buildEventContext({
      events: [],
      systemEvents: ["alert-1", "alert-2"],
    });

    assert.ok(result.text.includes("## System Events"));
    assert.ok(result.text.includes("alert-1"));
    assert.ok(result.text.includes("alert-2"));
  });

  it("recentTranscript を注入できる", () => {
    const result = buildEventContext({
      events: [],
      recentTranscript: [transcriptEvent],
    });

    assert.ok(result.text.includes("## Recent Session Transcript"));
    assert.ok(result.text.includes("user: 直近の会話です"));
  });

  it("maxTokenEstimate 超過時は切り詰める", () => {
    const longText = "x".repeat(10_000);
    const result = buildEventContext({
      events: [createEvent({ subject: longText })],
      maxTokenEstimate: 10,
    });

    assert.equal(result.truncated, true);
    assert.ok(result.text.length <= 40);
  });

  it("heartbeat/chat の入力パターンどちらでも組み立て可能", () => {
    const heartbeat = buildEventContext({
      events: [createEvent({ uid: "heartbeat-1" })],
      systemEvents: [],
    });
    const chat = buildEventContext({
      events: [],
      systemEvents: ["follow-up needed"],
    });

    assert.ok(
      heartbeat.text.includes("heartbeat-1") || heartbeat.text.includes("Recent Slack Events")
    );
    assert.ok(chat.text.includes("follow-up needed"));
  });
});
