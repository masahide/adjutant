export type AttentionWindowPushInput<T> = {
  sessionKey: string;
  item: T;
  idleMs: number;
  maxWaitMs: number;
};

export type AttentionWindow<T> = {
  push: (input: AttentionWindowPushInput<T>) => void;
  flushSession: (sessionKey: string) => Promise<void>;
  clearSession: (sessionKey: string) => number;
};

type BufferState<T> = {
  items: T[];
  firstAtMs: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  maxWaitTimer?: ReturnType<typeof setTimeout>;
};

export type AttentionWindowOptions<T> = {
  nowMs?: () => number;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
  onFlush: (input: { sessionKey: string; items: T[] }) => Promise<void>;
};

function normalizePositiveMs(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeSessionKey(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("attention-window requires non-empty sessionKey");
  }
  return normalized;
}

export function createAttentionWindow<T>(options: AttentionWindowOptions<T>): AttentionWindow<T> {
  const nowMs = options.nowMs ?? (() => Date.now());
  const buffers = new Map<string, BufferState<T>>();

  const flushByKey = async (sessionKey: string): Promise<void> => {
    const buffer = buffers.get(sessionKey);
    if (buffer === undefined) {
      return;
    }
    if (buffer.idleTimer !== undefined) {
      clearTimeout(buffer.idleTimer);
    }
    if (buffer.maxWaitTimer !== undefined) {
      clearTimeout(buffer.maxWaitTimer);
    }
    buffers.delete(sessionKey);
    if (buffer.items.length === 0) {
      return;
    }
    try {
      await options.onFlush({ sessionKey, items: buffer.items });
    } catch (error) {
      options.onWarn?.("attention-window.flush-failed", {
        sessionKey,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const scheduleIdle = (sessionKey: string, idleMs: number): void => {
    const buffer = buffers.get(sessionKey);
    if (buffer === undefined) {
      return;
    }
    if (buffer.idleTimer !== undefined) {
      clearTimeout(buffer.idleTimer);
    }
    buffer.idleTimer = setTimeout(() => {
      void flushByKey(sessionKey);
    }, normalizePositiveMs(idleMs));
  };

  return {
    push: (input) => {
      const sessionKey = normalizeSessionKey(input.sessionKey);
      const idleMs = normalizePositiveMs(input.idleMs);
      const maxWaitMs = normalizePositiveMs(input.maxWaitMs);
      const existing = buffers.get(sessionKey);
      if (existing === undefined) {
        const created: BufferState<T> = {
          items: [input.item],
          firstAtMs: nowMs(),
        };
        created.maxWaitTimer = setTimeout(() => {
          void flushByKey(sessionKey);
        }, maxWaitMs);
        buffers.set(sessionKey, created);
        scheduleIdle(sessionKey, idleMs);
        return;
      }

      existing.items.push(input.item);
      const elapsed = Math.max(0, nowMs() - existing.firstAtMs);
      if (elapsed >= maxWaitMs) {
        void flushByKey(sessionKey);
        return;
      }
      scheduleIdle(sessionKey, idleMs);
    },
    flushSession: async (sessionKey) => {
      await flushByKey(normalizeSessionKey(sessionKey));
    },
    clearSession: (sessionKey) => {
      const normalized = normalizeSessionKey(sessionKey);
      const existing = buffers.get(normalized);
      if (existing === undefined) {
        return 0;
      }
      if (existing.idleTimer !== undefined) {
        clearTimeout(existing.idleTimer);
      }
      if (existing.maxWaitTimer !== undefined) {
        clearTimeout(existing.maxWaitTimer);
      }
      buffers.delete(normalized);
      return 1;
    },
  };
}
