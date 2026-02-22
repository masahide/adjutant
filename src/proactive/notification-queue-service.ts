import type { NormalizedEvent } from "../core/events.js";

export type NotificationQueueConfig = {
  cap: number;
  debounceMs: number;
  dropPolicy: "summarize" | "old" | "new";
  maxDispatchChars: number;
  maxEventUidsPerDispatch: number;
};

export const DEFAULT_NOTIFICATION_QUEUE_CONFIG: NotificationQueueConfig = {
  cap: 20,
  debounceMs: 1000,
  dropPolicy: "summarize",
  maxDispatchChars: 4000,
  maxEventUidsPerDispatch: 50,
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

type QueueDispatchInput = {
  queueKey: string;
  accountId: string;
  originSessionKey: string;
  channelKey?: string;
  senderId?: string;
  threadKey?: string;
  events: NormalizedEvent[];
};

type NotificationQueueServiceDeps = {
  config: NotificationQueueConfig;
  dispatch: (input: QueueDispatchInput) => Promise<void>;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
  enqueueSystemEvent?: (text: string, opts: { sessionKey: string; contextKey?: string }) => void;
};

type QueueEnqueueInput = {
  queueKey: string;
  accountId: string;
  originSessionKey: string;
  channelKey?: string;
  senderId?: string;
  threadKey?: string;
  event: NormalizedEvent;
};

export function resolveNotificationQueueConfig(
  overrides: Partial<NotificationQueueConfig> | undefined
): NotificationQueueConfig {
  return {
    ...DEFAULT_NOTIFICATION_QUEUE_CONFIG,
    ...(overrides ?? {}),
  };
}

export class NotificationQueueService {
  private readonly buffers = new Map<string, EventBuffer>();

  constructor(private readonly deps: NotificationQueueServiceDeps) {}

  async enqueue(input: QueueEnqueueInput): Promise<void> {
    const existing = this.buffers.get(input.queueKey);
    if (existing) {
      if (existing.events.length >= this.deps.config.cap) {
        if (this.deps.config.dropPolicy === "new") {
          this.deps.onWarn?.("pipeline-buffer-cap-reached", {
            queueKey: input.queueKey,
            drop: "new",
          });
          return;
        }
        if (this.deps.config.dropPolicy === "old") {
          existing.events.shift();
        } else {
          this.deps.enqueueSystemEvent?.(
            `[Queue overflow] Dropped 1 event for ${existing.originSessionKey} due to cap=${this.deps.config.cap}.`,
            {
              sessionKey: existing.originSessionKey,
              contextKey: `${input.queueKey}:overflow`,
            }
          );
          existing.events.shift();
        }
      }
      existing.events.push(input.event);
      this.scheduleFlush(input.queueKey);
      return;
    }

    this.buffers.set(input.queueKey, {
      queueKey: input.queueKey,
      accountId: input.accountId,
      originSessionKey: input.originSessionKey,
      channelKey: input.channelKey,
      senderId: input.senderId,
      threadKey: input.threadKey,
      events: [input.event],
      timer: null,
    });
    this.scheduleFlush(input.queueKey);
  }

  async flushSession(sessionKey: string): Promise<void> {
    const queueKeys = Array.from(this.buffers.entries())
      .filter(([, buffer]) => buffer.originSessionKey === sessionKey)
      .map(([queueKey]) => queueKey);
    for (const queueKey of queueKeys) {
      await this.flushQueueKey(queueKey);
    }
  }

  clearSession(sessionKey: string): number {
    let removed = 0;
    for (const [queueKey, buffer] of this.buffers.entries()) {
      if (buffer.originSessionKey !== sessionKey) {
        continue;
      }
      if (buffer.timer) {
        clearTimeout(buffer.timer);
      }
      this.buffers.delete(queueKey);
      removed += 1;
    }
    return removed;
  }

  private async flushQueueKey(queueKey: string): Promise<void> {
    const buffer = this.buffers.get(queueKey);
    if (!buffer) {
      return;
    }
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }
    this.buffers.delete(queueKey);
    if (buffer.events.length === 0) {
      return;
    }
    try {
      await this.deps.dispatch({
        queueKey: buffer.queueKey,
        accountId: buffer.accountId,
        originSessionKey: buffer.originSessionKey,
        channelKey: buffer.channelKey,
        senderId: buffer.senderId,
        threadKey: buffer.threadKey,
        events: buffer.events,
      });
    } catch (error) {
      this.deps.onWarn?.("pipeline-dispatch-failed", {
        queueKey,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private scheduleFlush(queueKey: string): void {
    const buffer = this.buffers.get(queueKey);
    if (!buffer || buffer.timer) {
      return;
    }
    buffer.timer = setTimeout(
      () => {
        void this.flushQueueKey(queueKey);
      },
      Math.max(1, this.deps.config.debounceMs)
    );
  }
}
