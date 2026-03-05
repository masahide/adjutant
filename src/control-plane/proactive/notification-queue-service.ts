import type { GlobalConcurrencyQueue, GlobalQueueSource } from "./global-concurrency-queue.js";

export type NotificationQueueEntry<TPayload> = {
  queueKey: string;
  sessionKey: string;
  source: GlobalQueueSource;
  entries: TPayload[];
};

export type NotificationQueueFlushInput<TPayload> = {
  queueKey: string;
  sessionKey: string;
  source: GlobalQueueSource;
  firstEnqueuedAtMs: number;
  entries: TPayload[];
};

export type NotificationQueueServiceOptions<TPayload> = {
  debounceMs?: number;
  nowMs?: () => number;
  globalQueue?: GlobalConcurrencyQueue;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
  onFlush: (input: NotificationQueueFlushInput<TPayload>) => Promise<void>;
};

type BufferState<TPayload> = {
  queueKey: string;
  sessionKey: string;
  source: GlobalQueueSource;
  firstEnqueuedAtMs: number;
  entries: TPayload[];
  timer?: ReturnType<typeof setTimeout>;
};

function normalizeSessionKey(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("notification queue requires non-empty sessionKey");
  }
  return normalized;
}

function normalizeQueueKey(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("notification queue requires non-empty queueKey");
  }
  return normalized;
}

export class NotificationQueueService<TPayload> {
  private readonly buffers = new Map<string, BufferState<TPayload>>();
  private readonly nowMs: () => number;
  private readonly debounceMs: number;

  constructor(private readonly options: NotificationQueueServiceOptions<TPayload>) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.debounceMs = Math.max(1, Math.floor(options.debounceMs ?? 1));
  }

  async enqueue(input: NotificationQueueEntry<TPayload>): Promise<void> {
    const queueKey = normalizeQueueKey(input.queueKey);
    const sessionKey = normalizeSessionKey(input.sessionKey);
    if (input.entries.length === 0) {
      return;
    }

    const existing = this.buffers.get(queueKey);
    if (existing !== undefined) {
      existing.entries.push(...input.entries);
      this.scheduleFlush(queueKey);
      return;
    }

    this.buffers.set(queueKey, {
      queueKey,
      sessionKey,
      source: input.source,
      firstEnqueuedAtMs: this.nowMs(),
      entries: [...input.entries],
    });
    this.scheduleFlush(queueKey);
  }

  async flushSession(sessionKey: string): Promise<void> {
    const normalized = normalizeSessionKey(sessionKey);
    const targets = [...this.buffers.entries()]
      .filter(([, value]) => value.sessionKey === normalized)
      .map(([queueKey]) => queueKey);
    for (const queueKey of targets) {
      await this.flushQueueKey(queueKey);
    }
  }

  clearSession(sessionKey: string): number {
    const normalized = normalizeSessionKey(sessionKey);
    let removed = 0;
    for (const [queueKey, state] of this.buffers.entries()) {
      if (state.sessionKey !== normalized) {
        continue;
      }
      if (state.timer !== undefined) {
        clearTimeout(state.timer);
      }
      this.buffers.delete(queueKey);
      removed += 1;
    }
    return removed;
  }

  private scheduleFlush(queueKey: string): void {
    const state = this.buffers.get(queueKey);
    if (state === undefined) {
      return;
    }
    if (state.timer !== undefined) {
      return;
    }
    state.timer = setTimeout(() => {
      void this.flushQueueKey(queueKey);
    }, this.debounceMs);
  }

  private async flushQueueKey(queueKey: string): Promise<void> {
    const state = this.buffers.get(queueKey);
    if (state === undefined) {
      return;
    }
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    this.buffers.delete(queueKey);
    if (state.entries.length === 0) {
      return;
    }

    let release: (() => void) | undefined;
    try {
      if (this.options.globalQueue !== undefined) {
        const lease = await this.options.globalQueue.acquire(state.source);
        release = lease.release;
      }
      await this.options.onFlush({
        queueKey: state.queueKey,
        sessionKey: state.sessionKey,
        source: state.source,
        firstEnqueuedAtMs: state.firstEnqueuedAtMs,
        entries: state.entries,
      });
    } catch (error) {
      this.options.onWarn?.("notification-queue.flush-failed", {
        queueKey,
        sessionKey: state.sessionKey,
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      release?.();
    }
  }
}
