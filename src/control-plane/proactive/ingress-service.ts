import type { NormalizedEvent } from "../../core/events.js";
import { createAttentionWindow, type AttentionWindow } from "./attention-window.js";
import { createBatchClassifier, type BatchClassifier } from "./batch-classifier.js";
import {
  createGlobalConcurrencyQueue,
  type GlobalConcurrencyQueue,
  type GlobalQueueSource,
} from "./global-concurrency-queue.js";
import {
  NotificationQueueService,
  type NotificationQueueFlushInput,
} from "./notification-queue-service.js";
import { createRuleTriage, type RuleTriage } from "./rule-triage.js";

export type AttentionWindowConfig = {
  channelIdleMs: number;
  channelMaxWaitMs: number;
  dmIdleMs: number;
  dmMaxWaitMs: number;
};

export type ProactiveIngressItem<TPayload> = {
  sessionKey: string;
  event: NormalizedEvent;
  payload: TPayload;
};

export type ProactiveDispatchInput<TPayload> = {
  queueKey: string;
  sessionKey: string;
  source: GlobalQueueSource;
  firstEnqueuedAtMs: number;
  items: ProactiveIngressItem<TPayload>[];
};

export type ProactiveSystemEvent = {
  sessionKey: string;
  level: "note";
  reason: string;
  itemCount: number;
};

export type ProactiveIngressService<TPayload> = {
  ingest: (item: ProactiveIngressItem<TPayload>) => Promise<void>;
  flushSession: (sessionKey: string) => Promise<void>;
  clearSession: (sessionKey: string) => number;
};

export type ProactiveIngressServiceOptions<TPayload> = {
  attentionWindowConfig?: Partial<AttentionWindowConfig>;
  ruleTriage?: RuleTriage;
  batchClassifier?: BatchClassifier;
  globalQueue?: GlobalConcurrencyQueue;
  attentionWindow?: AttentionWindow<BufferedItem<TPayload>>;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
  onSystemEvent?: (event: ProactiveSystemEvent) => void;
  dispatch: (input: ProactiveDispatchInput<TPayload>) => Promise<void>;
};

type BufferedItem<TPayload> = {
  source: GlobalQueueSource;
  item: ProactiveIngressItem<TPayload>;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

function resolveAttentionWindowConfig(
  overrides: Partial<AttentionWindowConfig> | undefined
): AttentionWindowConfig {
  const channelIdle =
    overrides?.channelIdleMs !== undefined
      ? String(overrides.channelIdleMs)
      : process.env.ADJUTANT_ROUTING_IDLE_MS;
  const channelMaxWait =
    overrides?.channelMaxWaitMs !== undefined
      ? String(overrides.channelMaxWaitMs)
      : process.env.ADJUTANT_ROUTING_MAX_WAIT_MS;
  const dmIdle =
    overrides?.dmIdleMs !== undefined
      ? String(overrides.dmIdleMs)
      : process.env.ADJUTANT_ROUTING_DM_IDLE_MS;
  const dmMaxWait =
    overrides?.dmMaxWaitMs !== undefined
      ? String(overrides.dmMaxWaitMs)
      : process.env.ADJUTANT_ROUTING_DM_MAX_WAIT_MS;
  return {
    channelIdleMs: parsePositiveInt(channelIdle, 1_000),
    channelMaxWaitMs: parsePositiveInt(channelMaxWait, 30_000),
    dmIdleMs: parsePositiveInt(dmIdle, 200),
    dmMaxWaitMs: parsePositiveInt(dmMaxWait, 1_000),
  };
}

function toQueueKey(sessionKey: string, source: GlobalQueueSource): string {
  return `${source}:${sessionKey}`;
}

export function createProactiveIngressService<TPayload>(
  options: ProactiveIngressServiceOptions<TPayload>
): ProactiveIngressService<TPayload> {
  const config = resolveAttentionWindowConfig(options.attentionWindowConfig);
  const triage =
    options.ruleTriage ?? createRuleTriage({ selfUserId: process.env.ADJUTANT_SLACK_SELF_USER_ID });
  const classifier = options.batchClassifier ?? createBatchClassifier();
  const globalQueue =
    options.globalQueue ??
    createGlobalConcurrencyQueue({
      maxConcurrent: parsePositiveInt(process.env.ADJUTANT_GLOBAL_MAX_CONCURRENT, 3),
      dmBurstSlot: parsePositiveInt(process.env.ADJUTANT_GLOBAL_DM_BURST_SLOT, 1),
      maxRunningDm: parsePositiveInt(process.env.ADJUTANT_GLOBAL_MAX_RUNNING_DM, 3),
      starvationMs: parsePositiveInt(process.env.ADJUTANT_GLOBAL_STARVATION_MS, 120_000),
    });
  const notificationQueue = new NotificationQueueService<ProactiveIngressItem<TPayload>>({
    debounceMs: 1,
    globalQueue,
    onWarn: options.onWarn,
    onFlush: async (input: NotificationQueueFlushInput<ProactiveIngressItem<TPayload>>) => {
      await options.dispatch({
        queueKey: input.queueKey,
        sessionKey: input.sessionKey,
        source: input.source,
        firstEnqueuedAtMs: input.firstEnqueuedAtMs,
        items: input.entries,
      });
    },
  });

  const attentionWindow =
    options.attentionWindow ??
    createAttentionWindow<BufferedItem<TPayload>>({
      onWarn: options.onWarn,
      onFlush: async ({ sessionKey, items }) => {
        const events = items.map((item) => item.item.event);
        const decision = await classifier.classify({
          sessionKey,
          events,
        });
        if (decision.action !== "respond") {
          options.onSystemEvent?.({
            sessionKey,
            level: "note",
            reason: decision.reason,
            itemCount: items.length,
          });
          return;
        }

        const source = items[0]?.source ?? "channel";
        const queueKey = toQueueKey(sessionKey, source);
        await notificationQueue.enqueue({
          queueKey,
          sessionKey,
          source,
          entries: items.map((item) => item.item),
        });
      },
    });

  return {
    ingest: async (item) => {
      const triageResult = triage.classify({
        sessionKey: item.sessionKey,
        event: item.event,
      });
      if (triageResult.route === "drop") {
        return;
      }
      if (triageResult.route === "immediate") {
        await notificationQueue.enqueue({
          queueKey: toQueueKey(item.sessionKey, triageResult.source),
          sessionKey: item.sessionKey,
          source: triageResult.source,
          entries: [item],
        });
        return;
      }

      const idleMs = triageResult.isDm ? config.dmIdleMs : config.channelIdleMs;
      const maxWaitMs = triageResult.isDm ? config.dmMaxWaitMs : config.channelMaxWaitMs;
      attentionWindow.push({
        sessionKey: item.sessionKey,
        idleMs,
        maxWaitMs,
        item: {
          source: triageResult.source,
          item,
        },
      });
    },
    flushSession: async (sessionKey) => {
      await attentionWindow.flushSession(sessionKey);
      await notificationQueue.flushSession(sessionKey);
    },
    clearSession: (sessionKey) => {
      const removedFromWindow = attentionWindow.clearSession(sessionKey);
      const removedFromQueue = notificationQueue.clearSession(sessionKey);
      return removedFromWindow + removedFromQueue;
    },
  };
}
