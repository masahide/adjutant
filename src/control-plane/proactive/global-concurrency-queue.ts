export type GlobalQueueSource = "dm" | "group" | "channel" | "flusher" | "heartbeat";

const SOURCE_PRIORITY: Record<GlobalQueueSource, number> = {
  dm: 900,
  group: 700,
  channel: 600,
  flusher: 500,
  heartbeat: 400,
};

export type GlobalConcurrencyQueueLease = {
  id: string;
  source: GlobalQueueSource;
  release: () => void;
};

export type GlobalConcurrencyQueue = {
  acquire: (source: GlobalQueueSource) => Promise<GlobalConcurrencyQueueLease>;
  release: (leaseOrId: GlobalConcurrencyQueueLease | string) => void;
};

export type GlobalConcurrencyQueueOptions = {
  maxConcurrent?: number;
  dmBurstSlot?: number;
  maxRunningDm?: number;
  starvationMs?: number;
  nowMs?: () => number;
};

type QueueEntry = {
  id: string;
  source: GlobalQueueSource;
  enqueuedAtMs: number;
  resolve: (lease: GlobalConcurrencyQueueLease) => void;
};

function effectivePriority(entry: QueueEntry, nowMs: number, starvationMs: number): number {
  const waited = Math.max(0, nowMs - entry.enqueuedAtMs);
  if (waited >= starvationMs) {
    return 1_000;
  }
  return SOURCE_PRIORITY[entry.source];
}

export function createGlobalConcurrencyQueue(
  options: GlobalConcurrencyQueueOptions = {}
): GlobalConcurrencyQueue {
  const nowMs = options.nowMs ?? (() => Date.now());
  const maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? 3));
  const dmBurstSlot = Math.max(0, Math.floor(options.dmBurstSlot ?? 1));
  const totalSlots = maxConcurrent + dmBurstSlot;
  const maxRunningDm = Math.max(1, Math.floor(options.maxRunningDm ?? totalSlots));
  const starvationMs = Math.max(1, Math.floor(options.starvationMs ?? 120_000));
  const waiting: QueueEntry[] = [];
  const running = new Map<string, GlobalQueueSource>();
  let runningDm = 0;
  let nextId = 1;

  const canRun = (entry: QueueEntry): boolean => {
    if (running.size >= totalSlots) {
      return false;
    }
    if (entry.source === "dm") {
      return runningDm < maxRunningDm;
    }
    return running.size < maxConcurrent;
  };

  const releaseById = (id: string): void => {
    const source = running.get(id);
    if (source === undefined) {
      return;
    }
    running.delete(id);
    if (source === "dm") {
      runningDm = Math.max(0, runningDm - 1);
    }
    tryDispatch();
  };

  const tryDispatch = (): void => {
    while (waiting.length > 0) {
      const now = nowMs();
      waiting.sort((left, right) => {
        const priorityDelta =
          effectivePriority(right, now, starvationMs) - effectivePriority(left, now, starvationMs);
        if (priorityDelta !== 0) {
          return priorityDelta;
        }
        return left.enqueuedAtMs - right.enqueuedAtMs;
      });
      const index = waiting.findIndex((entry) => canRun(entry));
      if (index < 0) {
        return;
      }
      const next = waiting.splice(index, 1)[0];
      running.set(next.id, next.source);
      if (next.source === "dm") {
        runningDm += 1;
      }
      next.resolve({
        id: next.id,
        source: next.source,
        release: () => {
          releaseById(next.id);
        },
      });
    }
  };

  return {
    acquire: async (source) => {
      const id = `gq-${String(nextId++)}`;
      return await new Promise<GlobalConcurrencyQueueLease>((resolve) => {
        waiting.push({
          id,
          source,
          enqueuedAtMs: nowMs(),
          resolve,
        });
        tryDispatch();
      });
    },
    release: (leaseOrId) => {
      if (typeof leaseOrId === "string") {
        releaseById(leaseOrId);
        return;
      }
      releaseById(leaseOrId.id);
    },
  };
}
