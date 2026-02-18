import type { NormalizedEvent } from "../core/events.js";

export type ChannelNotificationInput = {
  event: NormalizedEvent;
  accountId: string;
  channelId: string;
};

export type ChannelAccountSnapshot = {
  accountId: string;
  running?: boolean;
  connected?: boolean;
  lastError?: string | null;
  lastInboundAt?: number;
  lastStartAt?: number;
  lastStopAt?: number;
};

export type ChannelGatewayContext<TChannelRuntime = unknown> = {
  accountId: string;
  runtime: TChannelRuntime;
  abortSignal: AbortSignal;
  emit: (input: ChannelNotificationInput) => Promise<void>;
  getStatus: () => ChannelAccountSnapshot;
  setStatus: (next: ChannelAccountSnapshot) => void;
};

export type ChannelIngestionPlugin<TChannelRuntime = unknown> = {
  id: string;
  listAccountIds?: () => string[];
  startAccount: (ctx: ChannelGatewayContext<TChannelRuntime>) => Promise<unknown>;
  stopAccount?: (ctx: ChannelGatewayContext<TChannelRuntime>) => Promise<void>;
};
