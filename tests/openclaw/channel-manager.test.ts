import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChannelManager } from "../../src/openclaw/channel-manager.js";
import type {
  ChannelGatewayContext,
  ChannelIngestionPlugin,
  ChannelNotificationInput,
} from "../../src/openclaw/channel-plugin.js";
import { createChannelPluginRegistry } from "../../src/openclaw/plugin-registry.js";

type Runtime = { name: string };

function createEventInput(accountId: string): ChannelNotificationInput {
  return {
    accountId,
    channelId: "slack",
    event: {
      schema: "adjutant.event.v1.1",
      uid: "uid-1",
      source: "slack",
      kind: "post",
      ts: "2026-02-17T00:00:00+09:00",
      detail: {
        slack: {
          channel_id: "C123",
          message_ts: "1740000000.000100",
          text: "hello",
        },
      },
    },
  };
}

describe("channel-manager", () => {
  it("startChannels -> startAccount -> stopChannel が連携する", async () => {
    const registry = createChannelPluginRegistry<Runtime>();
    const emitted: ChannelNotificationInput[] = [];
    const starts: string[] = [];
    const stops: string[] = [];

    const plugin: ChannelIngestionPlugin<Runtime> = {
      id: "slack",
      listAccountIds: () => ["acc-1"],
      startAccount: async (ctx: ChannelGatewayContext<Runtime>) => {
        starts.push(`${ctx.accountId}:${ctx.runtime.name}`);
        await ctx.emit(createEventInput(ctx.accountId));
        await new Promise<void>((resolve) => {
          ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      stopAccount: async (ctx) => {
        stops.push(ctx.accountId);
      },
    };
    registry.register(plugin);

    const manager = createChannelManager<Runtime>({
      registry,
      channelRuntimeEnvs: { slack: { name: "runtime-slack" } },
      emit: async (input) => {
        emitted.push(input);
      },
    });

    await manager.startChannels();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const snapshotAfterStart = manager.getRuntimeSnapshot();
    assert.equal(starts.length, 1);
    assert.equal(starts[0], "acc-1:runtime-slack");
    assert.equal(emitted.length, 1);
    assert.equal(snapshotAfterStart.channels.slack?.["acc-1"]?.running, true);
    assert.equal(typeof snapshotAfterStart.channels.slack?.["acc-1"]?.lastInboundAt, "number");

    await manager.stopChannel("slack");
    const snapshotAfterStop = manager.getRuntimeSnapshot();
    assert.equal(stops.length, 1);
    assert.equal(stops[0], "acc-1");
    assert.equal(snapshotAfterStop.channels.slack?.["acc-1"]?.running, false);
  });
});
