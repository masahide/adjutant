import {
  type ChannelAccountSnapshot,
  type ChannelGatewayContext,
  type ChannelIngestionPlugin,
  type ChannelNotificationInput,
} from "./channel-plugin.js";
import type { ChannelPluginRegistry } from "./plugin-registry.js";

type ChannelRuntimeStore = {
  aborts: Map<string, AbortController>;
  tasks: Map<string, Promise<unknown>>;
  statuses: Map<string, ChannelAccountSnapshot>;
};

export type ChannelRuntimeSnapshot = {
  channels: Record<string, Record<string, ChannelAccountSnapshot>>;
};

export type ChannelManagerOptions<TChannelRuntime = unknown> = {
  registry: ChannelPluginRegistry<TChannelRuntime>;
  channelRuntimeEnvs?: Record<string, TChannelRuntime>;
  emit: (input: ChannelNotificationInput) => Promise<void>;
  onError?: (message: string, meta?: Record<string, unknown>) => void;
};

export type ChannelManager = {
  getRuntimeSnapshot: () => ChannelRuntimeSnapshot;
  startChannels: () => Promise<void>;
  startChannel: (channelId: string, accountId?: string) => Promise<void>;
  stopChannel: (channelId: string, accountId?: string) => Promise<void>;
};

function createRuntimeStore(): ChannelRuntimeStore {
  return {
    aborts: new Map(),
    tasks: new Map(),
    statuses: new Map(),
  };
}

function resolveAccountIds<TChannelRuntime>(
  plugin: ChannelIngestionPlugin<TChannelRuntime>,
  accountId?: string
): string[] {
  if (accountId?.trim()) {
    return [accountId.trim()];
  }
  const fromPlugin = plugin.listAccountIds?.().filter((value) => value.trim().length > 0) ?? [];
  if (fromPlugin.length > 0) {
    return fromPlugin;
  }
  return ["default"];
}

function ensureSnapshot(
  accountId: string,
  current?: ChannelAccountSnapshot
): ChannelAccountSnapshot {
  return current ?? { accountId };
}

export function createChannelManager<TChannelRuntime = unknown>(
  opts: ChannelManagerOptions<TChannelRuntime>
): ChannelManager {
  const stores = new Map<string, ChannelRuntimeStore>();

  const getStore = (channelId: string): ChannelRuntimeStore => {
    const existing = stores.get(channelId);
    if (existing) {
      return existing;
    }
    const created = createRuntimeStore();
    stores.set(channelId, created);
    return created;
  };

  const getStatus = (channelId: string, accountId: string): ChannelAccountSnapshot => {
    const store = getStore(channelId);
    return ensureSnapshot(accountId, store.statuses.get(accountId));
  };

  const setStatus = (channelId: string, accountId: string, next: ChannelAccountSnapshot): void => {
    const store = getStore(channelId);
    store.statuses.set(accountId, { ...next, accountId });
  };

  const createContext = (
    plugin: ChannelIngestionPlugin<TChannelRuntime>,
    channelId: string,
    accountId: string,
    abortSignal: AbortSignal
  ): ChannelGatewayContext<TChannelRuntime> => ({
    accountId,
    runtime: opts.channelRuntimeEnvs?.[plugin.id] as TChannelRuntime,
    abortSignal,
    emit: async (input) => {
      const now = Date.now();
      const current = getStatus(channelId, accountId);
      setStatus(channelId, accountId, {
        ...current,
        accountId,
        lastInboundAt: now,
      });
      await opts.emit(input);
    },
    getStatus: () => getStatus(channelId, accountId),
    setStatus: (next) => setStatus(channelId, accountId, next),
  });

  const startChannel = async (channelId: string, accountId?: string): Promise<void> => {
    const plugin = opts.registry.get(channelId);
    if (!plugin) {
      throw new Error(`channel plugin not found: ${channelId}`);
    }

    const store = getStore(channelId);
    const accountIds = resolveAccountIds(plugin, accountId);

    await Promise.all(
      accountIds.map(async (id) => {
        if (store.tasks.has(id)) {
          return;
        }

        const abort = new AbortController();
        store.aborts.set(id, abort);
        setStatus(channelId, id, {
          accountId: id,
          running: true,
          lastError: null,
          lastStartAt: Date.now(),
        });

        const context = createContext(plugin, channelId, id, abort.signal);
        const task = Promise.resolve(plugin.startAccount(context))
          .catch((error) => {
            const reason = error instanceof Error ? error.message : String(error);
            setStatus(channelId, id, {
              ...getStatus(channelId, id),
              accountId: id,
              running: false,
              lastError: reason,
            });
            opts.onError?.("channel-start-account-failed", {
              channelId,
              accountId: id,
              reason,
            });
          })
          .finally(() => {
            store.aborts.delete(id);
            store.tasks.delete(id);
            setStatus(channelId, id, {
              ...getStatus(channelId, id),
              accountId: id,
              running: false,
              lastStopAt: Date.now(),
            });
          });
        store.tasks.set(id, task);
      })
    );
  };

  const stopChannel = async (channelId: string, accountId?: string): Promise<void> => {
    const plugin = opts.registry.get(channelId);
    if (!plugin) {
      return;
    }
    const store = getStore(channelId);
    const accountIds = accountId?.trim()
      ? [accountId.trim()]
      : Array.from(
          new Set([...store.aborts.keys(), ...store.tasks.keys(), ...resolveAccountIds(plugin)])
        );

    await Promise.all(
      accountIds.map(async (id) => {
        const abort = store.aborts.get(id);
        const task = store.tasks.get(id);
        const context = createContext(
          plugin,
          channelId,
          id,
          abort?.signal ?? new AbortController().signal
        );
        abort?.abort();
        if (plugin.stopAccount) {
          await plugin.stopAccount(context);
        }
        try {
          await task;
        } catch {
          // ignore task error on stop path
        }
        store.aborts.delete(id);
        store.tasks.delete(id);
        setStatus(channelId, id, {
          ...getStatus(channelId, id),
          accountId: id,
          running: false,
          lastStopAt: Date.now(),
        });
      })
    );
  };

  const startChannels = async (): Promise<void> => {
    for (const plugin of opts.registry.list()) {
      await startChannel(plugin.id);
    }
  };

  const getRuntimeSnapshot = (): ChannelRuntimeSnapshot => {
    const channels: Record<string, Record<string, ChannelAccountSnapshot>> = {};
    for (const [channelId, store] of stores.entries()) {
      channels[channelId] = {};
      for (const [accountId, snapshot] of store.statuses.entries()) {
        channels[channelId][accountId] = { ...snapshot };
      }
    }
    return { channels };
  };

  return {
    getRuntimeSnapshot,
    startChannels,
    startChannel,
    stopChannel,
  };
}
