import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProactiveMetrics, type MetricRecord } from "../../src/proactive/metrics.js";

describe("proactive-metrics", () => {
  it("route_llm_calls_per_hour はローリング1時間窓で集計される", () => {
    let nowMs = Date.parse("2026-02-22T00:00:00.000Z");
    const records: MetricRecord[] = [];
    const metrics = createProactiveMetrics({
      now: () => new Date(nowMs),
      onRecord: (record) => records.push(record),
      rollingWindowMs: 3_600_000,
    });

    metrics.recordRouteLlmCall({ sessionKey: "slack:channel:C1" });
    nowMs += 10 * 60 * 1000;
    metrics.recordRouteLlmCall({ sessionKey: "slack:channel:C1" });
    nowMs += 10 * 60 * 1000;
    metrics.recordRouteLlmCall({ sessionKey: "slack:channel:C1" });

    const latest = records[records.length - 1];
    assert.equal(latest?.name, "route_llm_calls_per_hour");
    assert.equal(latest?.kind, "gauge");
    assert.equal(latest?.value, 3);

    nowMs += 61 * 60 * 1000;
    metrics.recordRouteLlmCall({ sessionKey: "slack:channel:C1" });
    const afterWindow = records[records.length - 1];
    assert.equal(afterWindow?.name, "route_llm_calls_per_hour");
    assert.equal(afterWindow?.value, 1);
  });

  it("flusher_fire_count と agent_invocations_by_source はカウントとタグを記録する", () => {
    let nowMs = Date.parse("2026-02-22T01:00:00.000Z");
    const records: MetricRecord[] = [];
    const metrics = createProactiveMetrics({
      now: () => new Date(nowMs),
      onRecord: (record) => records.push(record),
    });

    metrics.recordFlusherFire({ sessionKey: "slack:channel:C999", openPostCount: 2 });
    nowMs += 1000;
    metrics.recordAgentInvocation({ source: "dm" });
    nowMs += 1000;
    metrics.recordAgentInvocation({ source: "dm" });
    nowMs += 1000;
    metrics.recordAgentInvocation({ source: "channel" });

    const flusher = records.find((record) => record.name === "flusher_fire_count");
    assert.equal(flusher?.kind, "counter");
    assert.equal(flusher?.value, 1);
    assert.equal(flusher?.tags?.sessionKey, "slack:channel:C999");
    assert.equal(typeof flusher?.ts, "string");

    const agentBySource = records.filter((record) => record.name === "agent_invocations_by_source");
    assert.equal(agentBySource.length, 3);
    assert.equal(agentBySource[0]?.tags?.source, "dm");
    assert.equal(agentBySource[0]?.tags?.total, "1");
    assert.equal(agentBySource[1]?.tags?.source, "dm");
    assert.equal(agentBySource[1]?.tags?.total, "2");
    assert.equal(agentBySource[2]?.tags?.source, "channel");
    assert.equal(agentBySource[2]?.tags?.total, "1");
  });

  it("event_to_response_p95_ms はローリング窓の P95 を出力する", () => {
    let nowMs = Date.parse("2026-02-22T02:00:00.000Z");
    const records: MetricRecord[] = [];
    const metrics = createProactiveMetrics({
      now: () => new Date(nowMs),
      onRecord: (record) => records.push(record),
      rollingWindowMs: 3_600_000,
    });

    for (const value of [100, 150, 200, 250, 300, 350, 400, 450, 500, 550]) {
      metrics.recordEventToResponse({
        durationMs: value,
        queueKey: "queue-1",
        sessionKey: "slack:channel:C1",
      });
      nowMs += 1000;
    }

    const latest = records[records.length - 1];
    assert.equal(latest?.name, "event_to_response_p95_ms");
    assert.equal(latest?.kind, "gauge");
    assert.equal(latest?.unit, "ms");
    assert.equal(latest?.value, 550);
    assert.equal(latest?.tags?.sampleCount, "10");

    nowMs += 61 * 60 * 1000;
    metrics.recordEventToResponse({
      durationMs: 80,
      queueKey: "queue-1",
      sessionKey: "slack:channel:C1",
    });
    const afterWindow = records[records.length - 1];
    assert.equal(afterWindow?.name, "event_to_response_p95_ms");
    assert.equal(afterWindow?.value, 80);
    assert.equal(afterWindow?.tags?.sampleCount, "1");
  });
});
