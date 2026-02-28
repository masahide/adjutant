import type { NormalizedEvent } from "../core/events.js";

export type ResolveAccountIdInput = {
  event: NormalizedEvent;
  configuredDefaultAccountId?: string;
};

export type ResolveSessionKeyInput = {
  accountId: string;
  channelId?: string;
  channelType?: "im" | "mpim" | "channel" | "group";
  threadTs?: string;
  senderId?: string;
};

export type ResolveSessionKeyResult = {
  baseSessionKey: string;
  sessionKey: string;
  parentSessionKey?: string;
  chatType: "direct" | "group" | "channel";
};

export type ResolveAgentRouteInput = {
  runTarget?: "main" | "session";
  mainSessionKey?: string;
  originSessionKey: string;
};

export type ResolveAgentRouteResult = {
  runTarget: "main" | "session";
  sessionKey: string;
  originSessionKey: string;
};

export type ResolveQueueKeyInput = {
  accountId: string;
  sessionKey: string;
  senderId?: string;
  threadKey?: string;
  channelKey?: string;
};

function normalizeId(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}

function inferChannelType(
  channelId: string | undefined,
  configured: ResolveSessionKeyInput["channelType"]
): "im" | "mpim" | "channel" | "group" {
  if (configured) {
    return configured;
  }

  if (channelId?.startsWith("D")) {
    return "im";
  }
  if (channelId?.startsWith("G")) {
    return "group";
  }
  if (channelId?.startsWith("C")) {
    return "channel";
  }

  return "channel";
}

export function resolveAccountId(input: ResolveAccountIdInput): string {
  const meta = input.event.meta;
  if (meta && typeof meta.account_id === "string" && meta.account_id.trim().length > 0) {
    return meta.account_id.trim();
  }
  if (input.configuredDefaultAccountId?.trim()) {
    return input.configuredDefaultAccountId.trim();
  }
  return "default";
}

export function resolveThreadSessionKeys(input: ResolveSessionKeyInput): ResolveSessionKeyResult {
  const channelId = normalizeId(input.channelId) ?? "unknown";
  const channelType = inferChannelType(channelId, input.channelType);

  const baseSessionKey =
    channelType === "im"
      ? `slack:${channelId}`
      : channelType === "mpim" || channelType === "group"
        ? `slack:group:${channelId}`
        : `slack:channel:${channelId}`;

  const chatType =
    channelType === "im" ? "direct" : channelType === "channel" ? "channel" : "group";

  const threadTs = normalizeId(input.threadTs);
  if (!threadTs) {
    return {
      baseSessionKey,
      sessionKey: baseSessionKey,
      chatType,
    };
  }

  return {
    baseSessionKey,
    sessionKey: `${baseSessionKey}:thread:${threadTs}`,
    parentSessionKey: baseSessionKey,
    chatType,
  };
}

export function resolveAgentRoute(input: ResolveAgentRouteInput): ResolveAgentRouteResult {
  const originSessionKey = normalizeId(input.originSessionKey);
  if (!originSessionKey) {
    throw new Error("originSessionKey is required");
  }

  const runTarget = input.runTarget === "session" ? "session" : "main";
  if (runTarget === "session") {
    return {
      runTarget,
      sessionKey: originSessionKey,
      originSessionKey,
    };
  }

  return {
    runTarget,
    sessionKey: normalizeId(input.mainSessionKey) ?? "main",
    originSessionKey,
  };
}

export function resolveQueueKey(input: ResolveQueueKeyInput): string {
  const accountId = normalizeId(input.accountId);
  if (!accountId) {
    throw new Error("accountId is required");
  }

  const sessionKey = normalizeId(input.sessionKey);
  if (!sessionKey) {
    throw new Error("sessionKey is required");
  }

  const senderId = normalizeId(input.senderId) ?? "unknown-sender";
  const channelFallback = normalizeId(input.channelKey) ?? sessionKey;
  const threadKey = normalizeId(input.threadKey) ?? `channel:${channelFallback}`;
  return `${accountId}:${sessionKey}:${senderId}:${threadKey}`;
}
