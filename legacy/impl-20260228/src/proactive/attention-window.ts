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
  sessionKey: string;
  items: T[];
  firstAtMs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  maxWaitTimer: ReturnType<typeof setTimeout> | null;
};

export type AttentionWindowOptions<T> = {
  nowMs?: () => number;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
  onFlush: (input: { sessionKey: string; items: T[] }) => Promise<void>;
};

function normalizeMs(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(0, Math.floor(value));
}

function requireSessionKey(sessionKey: string): string {
  const normalized = sessionKey.trim();
  if (!normalized) {
    throw new Error("attention-window requires sessionKey");
  }
  return normalized;
}

export function createAttentionWindow<T>(options: AttentionWindowOptions<T>): AttentionWindow<T> {
  const nowMs = options.nowMs ?? (() => Date.now());
  const buffers = new Map<string, BufferState<T>>();

  const flushKey = async (sessionKey: string): Promise<void> => {
    const buffer = buffers.get(sessionKey);
    if (!buffer) {
      return;
    }
    if (buffer.idleTimer) {
      clearTimeout(buffer.idleTimer);
    }
    if (buffer.maxWaitTimer) {
      clearTimeout(buffer.maxWaitTimer);
    }
    buffers.delete(sessionKey);
    if (buffer.items.length === 0) {
      return;
    }
    try {
      await options.onFlush({ sessionKey, items: buffer.items });
    } catch (error) {
      options.onWarn?.("attention-window-flush-failed", {
        sessionKey,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const scheduleIdle = (sessionKey: string, idleMs: number): void => {
    const buffer = buffers.get(sessionKey);
    if (!buffer) {
      return;
    }
    if (buffer.idleTimer) {
      clearTimeout(buffer.idleTimer);
    }
    buffer.idleTimer = setTimeout(
      () => {
        void flushKey(sessionKey);
      },
      Math.max(1, idleMs)
    );
  };

  return {
    push: (input) => {
      const sessionKey = requireSessionKey(input.sessionKey);
      const idleMs = normalizeMs(input.idleMs);
      const maxWaitMs = normalizeMs(input.maxWaitMs);
      const existing = buffers.get(sessionKey);

      if (!existing) {
        const created: BufferState<T> = {
          sessionKey,
          items: [input.item],
          firstAtMs: nowMs(),
          idleTimer: null,
          maxWaitTimer: null,
        };
        buffers.set(sessionKey, created);
        if (maxWaitMs <= 0) {
          void flushKey(sessionKey);
          return;
        }
        created.maxWaitTimer = setTimeout(
          () => {
            void flushKey(sessionKey);
          },
          Math.max(1, maxWaitMs)
        );
        scheduleIdle(sessionKey, idleMs);
        return;
      }

      existing.items.push(input.item);
      const elapsed = Math.max(0, nowMs() - existing.firstAtMs);
      if (elapsed >= maxWaitMs) {
        void flushKey(sessionKey);
        return;
      }
      scheduleIdle(sessionKey, idleMs);
    },
    flushSession: async (sessionKey) => {
      await flushKey(requireSessionKey(sessionKey));
    },
    clearSession: (sessionKey) => {
      const normalized = requireSessionKey(sessionKey);
      const existing = buffers.get(normalized);
      if (!existing) {
        return 0;
      }
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer);
      }
      if (existing.maxWaitTimer) {
        clearTimeout(existing.maxWaitTimer);
      }
      buffers.delete(normalized);
      return 1;
    },
  };
}
