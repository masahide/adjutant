import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { IngestionAdapter } from "../../src/core/adapter.js";
import type { NormalizedEvent } from "../../src/core/events.js";
import type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
  ChannelNotificationInput,
} from "../../src/openclaw/channel-plugin.js";
import { createSlackChannelPlugin } from "../../src/openclaw/slack-channel-plugin.js";

class FakeClient extends EventEmitter {
  closeCount = 0;

  async close(): Promise<void> {
    this.closeCount += 1;
    this.emit("disconnect");
  }
}

function createPostEvent(uid: string): NormalizedEvent {
  return {
    schema: "adjutant.event.v1.1",
    uid,
    source: "slack",
    kind: "post",
    ts: "2026-02-17T00:00:00.000Z",
    detail: {
      slack: {
        channel_id: "C123",
        message_ts: "1740000000.000100",
        text: "hello",
      },
    },
  };
}

async function waitUntil(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 500;
  const intervalMs = opts.intervalMs ?? 10;
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timeout after ${timeoutMs}ms`);
}

describe("slack-channel-plugin", () => {
  it("startAccount は Slack イベントを writer と emit に流し、abort で停止する", async () => {
    const client = new FakeClient();
    const emitted: ChannelNotificationInput[] = [];
    const written: NormalizedEvent[] = [];
    const statusHistory: ChannelAccountSnapshot[] = [];
    let status: ChannelAccountSnapshot = { accountId: "acc-1" };
    let adapterStopCount = 0;

    const plugin = createSlackChannelPlugin({
      dataDir: "data",
      accountIds: ["acc-1"],
      connectToSlackPage: async () => ({
        client: client as never,
        slackUrl: "https://app.slack.com",
      }),
      createWriter: () => ({
        append: async (event) => {
          written.push(event);
        },
      }),
      createAdapter: () =>
        ({
          name: "slack-stub",
          start: async (emit) => {
            await emit(createPostEvent("uid-1"));
          },
          stop: async () => {
            adapterStopCount += 1;
          },
        }) satisfies IngestionAdapter,
      sleep: async () => {},
    });

    const abort = new AbortController();
    const context: ChannelGatewayContext<unknown> = {
      accountId: "acc-1",
      runtime: undefined,
      abortSignal: abort.signal,
      emit: async (input) => {
        emitted.push(input);
      },
      getStatus: () => status,
      setStatus: (next) => {
        status = { ...next };
        statusHistory.push({ ...status });
      },
    };

    const running = plugin.startAccount(context);
    await waitUntil(() => emitted.length === 1 && written.length === 1);
    abort.abort();
    await running;

    assert.equal(emitted.length, 1);
    assert.equal(written.length, 1);
    assert.equal(emitted[0]?.event.uid, "uid-1");
    assert.equal(emitted[0]?.channelId, "slack");
    assert.equal(emitted[0]?.accountId, "acc-1");
    assert.equal(
      statusHistory.some((snapshot) => snapshot.connected === true),
      true
    );
    assert.equal(adapterStopCount >= 1, true);
    assert.equal(client.closeCount >= 1, true);
  });

  it("接続失敗時は再試行し、recover 後に起動継続できる", async () => {
    const client = new FakeClient();
    let connectCount = 0;
    const warnings: string[] = [];
    const sleepDurations: number[] = [];

    const plugin = createSlackChannelPlugin({
      dataDir: "data",
      accountIds: ["acc-1"],
      retryBaseMs: 5,
      retryMaxMs: 5,
      connectToSlackPage: async () => {
        connectCount += 1;
        if (connectCount === 1) {
          throw new Error("connect failed once");
        }
        return { client: client as never, slackUrl: "https://app.slack.com" };
      },
      createWriter: () => ({ append: async () => {} }),
      createAdapter: () =>
        ({
          name: "slack-stub",
          start: async () => {},
          stop: async () => {},
        }) satisfies IngestionAdapter,
      sleep: async (ms) => {
        sleepDurations.push(ms);
      },
      onWarn: (message) => {
        warnings.push(message);
      },
    });

    const abort = new AbortController();
    let status: ChannelAccountSnapshot = { accountId: "acc-1" };
    const context: ChannelGatewayContext<unknown> = {
      accountId: "acc-1",
      runtime: undefined,
      abortSignal: abort.signal,
      emit: async () => {},
      getStatus: () => status,
      setStatus: (next) => {
        status = { ...next };
      },
    };

    const running = plugin.startAccount(context);
    await waitUntil(() => connectCount >= 2);
    abort.abort();
    await running;

    assert.equal(connectCount >= 2, true);
    assert.equal(sleepDurations.includes(5), true);
    assert.equal(warnings.includes("slack-plugin-start-failed"), true);
  });
});
