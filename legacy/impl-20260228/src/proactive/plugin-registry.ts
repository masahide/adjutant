import type { ChannelIngestionPlugin } from "./channel-plugin.js";

export type ChannelPluginRegistry<TChannelRuntime = unknown> = {
  register: (plugin: ChannelIngestionPlugin<TChannelRuntime>) => void;
  get: (channelId: string) => ChannelIngestionPlugin<TChannelRuntime> | null;
  list: () => Array<ChannelIngestionPlugin<TChannelRuntime>>;
  clear: () => void;
};

export function createChannelPluginRegistry<
  TChannelRuntime = unknown,
>(): ChannelPluginRegistry<TChannelRuntime> {
  const plugins = new Map<string, ChannelIngestionPlugin<TChannelRuntime>>();

  return {
    register: (plugin) => {
      const id = plugin.id?.trim();
      if (!id) {
        throw new Error("plugin id is required");
      }
      plugins.set(id, plugin);
    },
    get: (channelId) => {
      const id = channelId.trim();
      if (!id) {
        return null;
      }
      return plugins.get(id) ?? null;
    },
    list: () => Array.from(plugins.values()),
    clear: () => {
      plugins.clear();
    },
  };
}
