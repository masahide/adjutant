import type { PostChatMessageRequest, PostChatMessageResponse } from "../assistant/api-types.js";
import type { NormalizedEvent } from "../core/events.js";
import type { BatchClassifier } from "./batch-classifier.js";
import {
  toApiRequest,
  toChatDispatchRequest,
  type ChatDispatchRequest,
  type DispatchAdapterInput,
} from "./dispatch-adapter.js";
import type { ChannelNotificationInput } from "./channel-plugin.js";
import type { DualWriteCoordinator, DualWriteRecord } from "./dual-write-coordinator.js";
import {
  NotificationQueueService,
  resolveNotificationQueueConfig,
  type NotificationQueueConfig,
} from "./notification-queue-service.js";
import type { GlobalConcurrencyQueue, GlobalQueueSource } from "./global-concurrency-queue.js";
import type { ProactiveMetrics } from "./metrics.js";
import type { SelfMessageState } from "./route-decision.js";
import { resolveQueueKey, resolveThreadSessionKeys } from "./session-route-resolver.js";
import { createAttentionWindow, type AttentionWindow } from "./attention-window.js";
import { createRuleTriage, type RuleTriage, type RuleTriageResult } from "./rule-triage.js";
import { createTriggerFilter, type TriggerFilter } from "./trigger-filter.js";
import { TIMELINE_RECORD_SCHEMA_V1_5 } from "./types.js";

export type { NotificationQueueConfig };
export type { RuleTriage };

export type AttentionWindowConfig = {
  channelIdleMs: number;
  channelMaxWaitMs: number;
  dmIdleMs: number;
  dmMaxWaitMs: number;
};

export type ChannelNotificationPipelineDeps = {
  triggerFilter?: TriggerFilter;
  ruleTriage?: RuleTriage;
  batchClassifier?: BatchClassifier;
  attentionWindow?: AttentionWindow<BufferedPipelineEvent>;
  attentionWindowConfig?: Partial<AttentionWindowConfig>;
  globalConcurrencyQueue?: GlobalConcurrencyQueue;
  metrics?: ProactiveMetrics;
  nowMs?: () => number;
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

type BufferedPipelineEvent = {
  input: ChannelNotificationInput;
  sessionKey: string;
  queueKey: string;
  channelKey: string;
  senderId?: string;
  threadKey?: string;
  selfState: SelfMessageState;
  triage: RuleTriageResult;
  ingressAtMs: number;
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

function buildDualWriteRecords(params: { input: ChannelNotificationInput; sessionKey: string }): {
  timelineRecord: DualWriteRecord;
  sessionRecord: DualWriteRecord;
} {
  const loggedAt = params.input.event.logged_at ?? new Date().toISOString();
  const base = {
    schema: TIMELINE_RECORD_SCHEMA_V1_5,
    recordType: "event",
    uid: params.input.event.uid,
    role: "user",
    kind: params.input.event.kind,
    actor: params.input.event.actor,
    ts: params.input.event.ts,
    loggedAt,
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

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

function resolveAttentionWindowConfig(
  overrides: Partial<AttentionWindowConfig> | undefined,
  queueConfig: NotificationQueueConfig
): AttentionWindowConfig {
  const fallbackIdle = Math.max(1, queueConfig.debounceMs);
  const env = process.env;
  return {
    channelIdleMs: Math.max(
      1,
      Math.floor(
        overrides?.channelIdleMs ?? parsePositiveInt(env.ADJUTANT_ROUTING_IDLE_MS, fallbackIdle)
      )
    ),
    channelMaxWaitMs: Math.max(
      1,
      Math.floor(
        overrides?.channelMaxWaitMs ??
          parsePositiveInt(env.ADJUTANT_ROUTING_MAX_WAIT_MS, Math.max(30_000, fallbackIdle))
      )
    ),
    dmIdleMs: Math.max(
      1,
      Math.floor(
        overrides?.dmIdleMs ??
          parsePositiveInt(env.ADJUTANT_ROUTING_DM_IDLE_MS, Math.min(200, fallbackIdle))
      )
    ),
    dmMaxWaitMs: Math.max(
      1,
      Math.floor(
        overrides?.dmMaxWaitMs ??
          parsePositiveInt(env.ADJUTANT_ROUTING_DM_MAX_WAIT_MS, Math.max(1000, fallbackIdle))
      )
    ),
  };
}

function resolveGlobalSourceFromEvents(events: NormalizedEvent[]): GlobalQueueSource {
  const first = events[0];
  if (!first) {
    return "channel";
  }
  const channelId = extractChannelId(first);
  if (channelId?.startsWith("D")) {
    return "dm";
  }
  if (channelId?.startsWith("G")) {
    return "group";
  }
  return "channel";
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
  const ruleTriage = deps.ruleTriage ?? createRuleTriage();
  const batchClassifier = deps.batchClassifier;
  const dispatchAdapter = deps.dispatchAdapter ?? toChatDispatchRequest;
  const apiAdapter = deps.toApiRequest ?? toApiRequest;
  const queueConfig = resolveNotificationQueueConfig(deps.queueConfig);
  const queueServiceConfig: NotificationQueueConfig = {
    ...queueConfig,
    debounceMs: 1,
  };
  const nowMs = deps.nowMs ?? (() => Date.now());
  const windowConfig = resolveAttentionWindowConfig(deps.attentionWindowConfig, queueConfig);
  const queueService = new NotificationQueueService({
    config: queueServiceConfig,
    nowMs,
    enqueueSystemEvent: deps.enqueueSystemEvent,
    onWarn: deps.onWarn,
    dispatch: async (buffer) => {
      let releaseLease: (() => void) | undefined;
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
      if (deps.globalConcurrencyQueue) {
        const lease = await deps.globalConcurrencyQueue.acquire({
          source: resolveGlobalSourceFromEvents(buffer.events),
        });
        releaseLease = lease.release;
      }
      try {
        await deps.acceptMessage(request);
        deps.metrics?.recordEventToResponse({
          durationMs: Math.max(0, nowMs() - buffer.firstEnqueuedAtMs),
          queueKey: buffer.queueKey,
          sessionKey: buffer.originSessionKey,
        });
      } finally {
        releaseLease?.();
      }
    },
  });

  const processBufferedEvent = async (event: BufferedPipelineEvent): Promise<void> => {
    const decision =
      event.triage.route === "immediate" && event.input.event.kind === "post"
        ? {
            run: true,
            pending: false,
            drop: false,
            system: false,
            reason: "rule-immediate",
          }
        : await triggerFilter.decide({
            event: event.input.event,
            selfState: event.selfState,
          });

    if (decision.system && deps.enqueueSystemEvent) {
      deps.enqueueSystemEvent(renderSystemEventText(event.input.event), {
        sessionKey: event.sessionKey,
        contextKey: buildSystemContextKey(event.input.event),
      });
    }
    if (!decision.run) {
      return;
    }

    await queueService.enqueue({
      queueKey: event.queueKey,
      accountId: event.input.accountId,
      originSessionKey: event.sessionKey,
      channelKey: event.channelKey,
      senderId: event.senderId,
      threadKey: event.threadKey,
      event: event.input.event,
      enqueuedAtMs: event.ingressAtMs,
    });
  };

  const attentionWindow =
    deps.attentionWindow ??
    createAttentionWindow<BufferedPipelineEvent>({
      onWarn: deps.onWarn,
      onFlush: async ({ items }) => {
        const immediateItems = items.filter((item) => item.triage.route === "immediate");
        const accumulateItems = items.filter((item) => item.triage.route !== "immediate");

        for (const item of immediateItems) {
          await processBufferedEvent(item);
        }

        if (accumulateItems.length === 0) {
          return;
        }

        if (!batchClassifier) {
          for (const item of accumulateItems) {
            await processBufferedEvent(item);
          }
          return;
        }

        const head = accumulateItems[0];
        const classification = await batchClassifier.classify({
          sessionKey: head?.sessionKey ?? "main",
          events: accumulateItems.map((item) => item.input.event),
        });

        if (classification.action === "ignore") {
          return;
        }
        if (classification.action === "note") {
          deps.enqueueSystemEvent?.(
            `[Route note] ${classification.reason} (confidence=${classification.confidence.toFixed(2)})`,
            {
              sessionKey: head?.sessionKey ?? "main",
              contextKey: `${head?.queueKey ?? "unknown"}:batch-note`,
            }
          );
          return;
        }

        for (const item of accumulateItems) {
          await queueService.enqueue({
            queueKey: item.queueKey,
            accountId: item.input.accountId,
            originSessionKey: item.sessionKey,
            channelKey: item.channelKey,
            senderId: item.senderId,
            threadKey: item.threadKey,
            event: item.input.event,
            enqueuedAtMs: item.ingressAtMs,
          });
        }
      },
    });

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

    const triage = ruleTriage.classify({ event: input.event, selfState });
    if (triage.route === "drop") {
      return;
    }

    const isDm = triage.isDm;
    attentionWindow.push({
      sessionKey: session.sessionKey,
      idleMs: isDm ? windowConfig.dmIdleMs : windowConfig.channelIdleMs,
      maxWaitMs: isDm ? windowConfig.dmMaxWaitMs : windowConfig.channelMaxWaitMs,
      item: {
        input,
        sessionKey: session.sessionKey,
        queueKey,
        channelKey,
        senderId,
        threadKey,
        selfState,
        triage,
        ingressAtMs: nowMs(),
      },
    });
  };

  const flushSession = async (sessionKey: string): Promise<void> => {
    await attentionWindow.flushSession(sessionKey);
    await queueService.flushSession(sessionKey);
  };

  const clearSession = (sessionKey: string): number =>
    attentionWindow.clearSession(sessionKey) + queueService.clearSession(sessionKey);

  return {
    enqueue,
    flushSession,
    clearSession,
  };
}
