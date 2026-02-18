import type { PostChatMessageRequest, PostChatMessageResponse } from "../assistant/api-types.js";
import type { NormalizedEvent } from "../core/events.js";
import {
  toApiRequest,
  toChatDispatchRequest,
  type ChatDispatchRequest,
  type DispatchAdapterInput,
} from "./dispatch-adapter.js";
import type { ChannelNotificationInput } from "./channel-plugin.js";
import type { DualWriteCoordinator, DualWriteRecord } from "./dual-write-coordinator.js";
import type { SelfMessageState } from "./route-decision.js";
import { resolveQueueKey, resolveThreadSessionKeys } from "./session-route-resolver.js";
import { createTriggerFilter, type TriggerFilter } from "./trigger-filter.js";

export type NotificationQueueConfig = {
  cap: number;
  debounceMs: number;
  dropPolicy: "summarize" | "old" | "new";
  maxDispatchChars: number;
  maxEventUidsPerDispatch: number;
};

export type ChannelNotificationPipelineDeps = {
  triggerFilter?: TriggerFilter;
  acceptMessage: (
    request: PostChatMessageRequest
  ) => PostChatMessageResponse | Promise<PostChatMessageResponse>;
  enqueueSystemEvent?: (text: string, opts: { sessionKey: string; contextKey?: string }) => void;
  resolveSelfState?: (input: ChannelNotificationInput) => SelfMessageState;
  dispatchAdapter?: (input: DispatchAdapterInput) => ChatDispatchRequest;
  toApiRequest?: (dispatch: ChatDispatchRequest) => PostChatMessageRequest;
  dualWriteCoordinator?: DualWriteCoordinator;
  runTarget?: "main" | "session";
  mainSessionKey?: string;
  queueConfig?: Partial<NotificationQueueConfig>;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
};

type EventBuffer = {
  queueKey: string;
  accountId: string;
  originSessionKey: string;
  channelKey?: string;
  senderId?: string;
  threadKey?: string;
  events: NormalizedEvent[];
  timer: ReturnType<typeof setTimeout> | null;
};

const DEFAULT_QUEUE_CONFIG: NotificationQueueConfig = {
  cap: 20,
  debounceMs: 1000,
  dropPolicy: "summarize",
  maxDispatchChars: 4000,
  maxEventUidsPerDispatch: 50,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function extractSlackDetail(event: NormalizedEvent): Record<string, unknown> | null {
  const detail = asRecord(event.detail);
  if (!detail) {
    return null;
  }
  return asRecord(detail.slack);
}

function extractChannelId(event: NormalizedEvent): string | undefined {
  const slack = extractSlackDetail(event);
  const channelId = slack?.channel_id;
  if (typeof channelId === "string" && channelId.trim().length > 0) {
    return channelId.trim();
  }
  return undefined;
}

function extractThreadTs(event: NormalizedEvent): string | undefined {
  const slack = extractSlackDetail(event);
  const threadTs = slack?.thread_ts;
  if (typeof threadTs === "string" && threadTs.trim().length > 0) {
    return threadTs.trim();
  }
  return undefined;
}

function extractMessageTs(event: NormalizedEvent): string | undefined {
  const slack = extractSlackDetail(event);
  const messageTs = slack?.message_ts ?? slack?.event_ts;
  if (typeof messageTs === "string" && messageTs.trim().length > 0) {
    return messageTs.trim();
  }
  return undefined;
}

function extractSenderId(event: NormalizedEvent): string | undefined {
  const slack = extractSlackDetail(event);
  const sender = slack?.user;
  if (typeof sender === "string" && sender.trim().length > 0) {
    return sender.trim();
  }
  const actor = event.actor;
  if (typeof actor === "string" && actor.trim().length > 0) {
    return actor.trim();
  }
  return undefined;
}

function buildSystemContextKey(event: NormalizedEvent): string | undefined {
  const channelId = extractChannelId(event) ?? "unknown";
  const messageTs = extractMessageTs(event) ?? event.uid;
  if (event.kind === "post") {
    return `slack:message:${channelId}:${messageTs}`;
  }
  if (event.kind === "reaction") {
    const slack = extractSlackDetail(event);
    const emoji =
      typeof slack?.emoji === "string" && slack.emoji.trim().length > 0
        ? slack.emoji.trim()
        : "unknown";
    const actor = extractSenderId(event) ?? "unknown";
    const action = event.action?.trim() || "observed";
    return `slack:reaction:${channelId}:${messageTs}:${emoji}:${action}:${actor}`;
  }
  if (event.kind === "notification") {
    const slack = extractSlackDetail(event);
    const notificationType =
      typeof slack?.notification_type === "string" && slack.notification_type.trim().length > 0
        ? slack.notification_type.trim()
        : "unknown";
    return `slack:notification:${channelId}:${notificationType}:${messageTs}`;
  }
  return undefined;
}

function renderSystemEventText(event: NormalizedEvent): string {
  const channelId = extractChannelId(event) ?? "unknown";
  if (event.kind === "reaction") {
    const slack = extractSlackDetail(event);
    const emoji =
      typeof slack?.emoji === "string" && slack.emoji.trim().length > 0
        ? slack.emoji.trim()
        : "unknown";
    const actor = event.actor?.trim() || "unknown";
    return `[Slack reaction] ${actor} reacted (${emoji}) in ${channelId}.`;
  }
  if (event.kind === "notification") {
    const slack = extractSlackDetail(event);
    const notificationType =
      typeof slack?.notification_type === "string" && slack.notification_type.trim().length > 0
        ? slack.notification_type.trim()
        : "unknown";
    return `[Slack notification] type=${notificationType} channel=${channelId}.`;
  }
  return `[Slack event] kind=${event.kind} channel=${channelId}.`;
}

function resolveQueueConfig(
  overrides: Partial<NotificationQueueConfig> | undefined
): NotificationQueueConfig {
  return {
    ...DEFAULT_QUEUE_CONFIG,
    ...(overrides ?? {}),
  };
}

function buildDualWriteRecords(params: { input: ChannelNotificationInput; sessionKey: string }): {
  timelineRecord: DualWriteRecord;
  sessionRecord: DualWriteRecord;
} {
  const base = {
    recordType: "event",
    uid: params.input.event.uid,
    role: "user",
    kind: params.input.event.kind,
    ts: params.input.event.ts,
    accountId: params.input.accountId,
    channelId: params.input.channelId,
    sessionKey: params.sessionKey,
    event: params.input.event,
  };
  return {
    timelineRecord: { ...base, target: "timeline" },
    sessionRecord: { ...base, target: "session" },
  };
}

export type ChannelNotificationPipeline = {
  enqueue: (input: ChannelNotificationInput) => Promise<void>;
  flushSession: (sessionKey: string) => Promise<void>;
  clearSession: (sessionKey: string) => number;
};

export function createChannelNotificationPipeline(
  deps: ChannelNotificationPipelineDeps
): ChannelNotificationPipeline {
  const triggerFilter = deps.triggerFilter ?? createTriggerFilter();
  const dispatchAdapter = deps.dispatchAdapter ?? toChatDispatchRequest;
  const apiAdapter = deps.toApiRequest ?? toApiRequest;
  const queueConfig = resolveQueueConfig(deps.queueConfig);
  const buffers = new Map<string, EventBuffer>();

  const flushQueueKey = async (queueKey: string): Promise<void> => {
    const buffer = buffers.get(queueKey);
    if (!buffer) {
      return;
    }
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }
    buffers.delete(queueKey);
    if (buffer.events.length === 0) {
      return;
    }
    try {
      const dispatch = dispatchAdapter({
        events: buffer.events,
        accountId: buffer.accountId,
        originSessionKey: buffer.originSessionKey,
        runTarget: deps.runTarget,
        mainSessionKey: deps.mainSessionKey,
        maxDispatchChars: queueConfig.maxDispatchChars,
        maxEventUidsPerDispatch: queueConfig.maxEventUidsPerDispatch,
      });
      const request = apiAdapter(dispatch);
      await deps.acceptMessage(request);
    } catch (error) {
      deps.onWarn?.("pipeline-dispatch-failed", {
        queueKey,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const scheduleFlush = (queueKey: string): void => {
    const buffer = buffers.get(queueKey);
    if (!buffer || buffer.timer) {
      return;
    }
    buffer.timer = setTimeout(
      () => {
        void flushQueueKey(queueKey);
      },
      Math.max(1, queueConfig.debounceMs)
    );
  };

  const enqueue = async (input: ChannelNotificationInput): Promise<void> => {
    const channelId = extractChannelId(input.event);
    const threadTs = extractThreadTs(input.event);
    const senderId = extractSenderId(input.event);
    const session = resolveThreadSessionKeys({
      accountId: input.accountId,
      channelId,
      threadTs,
    });
    const threadKey = threadTs ? `thread:${threadTs}` : undefined;
    const channelKey = channelId ?? input.channelId;
    const queueKey = resolveQueueKey({
      accountId: input.accountId,
      sessionKey: session.sessionKey,
      senderId,
      threadKey,
      channelKey,
    });
    const selfState = deps.resolveSelfState?.(input) ?? "non-self";

    if (deps.dualWriteCoordinator) {
      const records = buildDualWriteRecords({
        input,
        sessionKey: session.sessionKey,
      });
      const writeResult = await deps.dualWriteCoordinator.appendEvent({
        uid: input.event.uid,
        timelineRecord: records.timelineRecord,
        sessionRecord: records.sessionRecord,
      });
      if (writeResult.status === "pending-timeline") {
        deps.onWarn?.("pipeline-dual-write-blocked", {
          uid: input.event.uid,
          sessionKey: session.sessionKey,
          reason: "pending-timeline",
        });
        return;
      }
      if (writeResult.status === "pending-session-backfill") {
        deps.onWarn?.("pipeline-dual-write-session-backfill", {
          uid: input.event.uid,
          sessionKey: session.sessionKey,
        });
      }
    }

    const decision = await triggerFilter.decide({
      event: input.event,
      selfState,
    });

    if (decision.system && deps.enqueueSystemEvent) {
      deps.enqueueSystemEvent(renderSystemEventText(input.event), {
        sessionKey: session.sessionKey,
        contextKey: buildSystemContextKey(input.event),
      });
    }
    if (!decision.run) {
      return;
    }

    const existing = buffers.get(queueKey);
    if (existing) {
      if (existing.events.length >= queueConfig.cap) {
        if (queueConfig.dropPolicy === "new") {
          deps.onWarn?.("pipeline-buffer-cap-reached", { queueKey, drop: "new" });
          return;
        }
        if (queueConfig.dropPolicy === "old") {
          existing.events.shift();
        } else {
          deps.enqueueSystemEvent?.(
            `[Queue overflow] Dropped 1 event for ${session.sessionKey} due to cap=${queueConfig.cap}.`,
            {
              sessionKey: session.sessionKey,
              contextKey: `${queueKey}:overflow`,
            }
          );
          existing.events.shift();
        }
      }
      existing.events.push(input.event);
      scheduleFlush(queueKey);
      return;
    }

    buffers.set(queueKey, {
      queueKey,
      accountId: input.accountId,
      originSessionKey: session.sessionKey,
      channelKey,
      senderId,
      threadKey,
      events: [input.event],
      timer: null,
    });
    scheduleFlush(queueKey);
  };

  const flushSession = async (sessionKey: string): Promise<void> => {
    const queueKeys = Array.from(buffers.entries())
      .filter(([, buffer]) => buffer.originSessionKey === sessionKey)
      .map(([queueKey]) => queueKey);
    for (const queueKey of queueKeys) {
      await flushQueueKey(queueKey);
    }
  };

  const clearSession = (sessionKey: string): number => {
    let removed = 0;
    for (const [queueKey, buffer] of buffers.entries()) {
      if (buffer.originSessionKey !== sessionKey) {
        continue;
      }
      if (buffer.timer) {
        clearTimeout(buffer.timer);
      }
      buffers.delete(queueKey);
      removed += 1;
    }
    return removed;
  };

  return {
    enqueue,
    flushSession,
    clearSession,
  };
}
