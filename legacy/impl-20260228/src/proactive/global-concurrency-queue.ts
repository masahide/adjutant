import type { ProactiveMetrics } from "./metrics.js";

export const PRIORITY_MAX = 1000;

export type GlobalQueueSource = "dm" | "group" | "channel" | "flusher" | "heartbeat";

const SOURCE_BASE_PRIORITY: Record<GlobalQueueSource, number> = {
  dm: 900,
  group: 700,
  channel: 600,
  flusher: 500,
  heartbeat: 400,
};

export type GlobalConcurrencyQueueConfig = {
  maxConcurrent?: number;
  dmBurstSlot?: number;
  maxRunningDM?: number;
  starvationMs?: number;
  nowMs?: () => number;
  metrics?: ProactiveMetrics;
};

export type GlobalConcurrencyLease = {
  id: string;
  source: GlobalQueueSource;
  release: () => void;
};

type QueueEntry = {
  id: string;
  source: GlobalQueueSource;
  basePriority: number;
  enqueuedAtMs: number;
  resolve: (lease: GlobalConcurrencyLease) => void;
};

export type GlobalConcurrencyQueue = {
  acquire: (input: { source: GlobalQueueSource }) => Promise<GlobalConcurrencyLease>;
  release: (leaseOrId: GlobalConcurrencyLease | string) => void;
  getSnapshot: () => {
    running: number;
    dmRunning: number;
    waiting: number;
    totalSlots: number;
    maxConcurrent: number;
    maxRunningDM: number;
  };
};

function effectivePriority(entry: QueueEntry, nowMs: number, starvationMs: number): number {
  const waitedMs = Math.max(0, nowMs - entry.enqueuedAtMs);
  if (waitedMs >= starvationMs) {
    return PRIORITY_MAX;
  }
  return entry.basePriority;
}

export function createGlobalConcurrencyQueue(
  config: GlobalConcurrencyQueueConfig = {}
): GlobalConcurrencyQueue {
  const nowMs = config.nowMs ?? (() => Date.now());
  const maxConcurrent = Math.max(1, Math.floor(config.maxConcurrent ?? 3));
  const dmBurstSlot = Math.max(0, Math.floor(config.dmBurstSlot ?? 1));
  const totalSlots = maxConcurrent + dmBurstSlot;
  const starvationMs = Math.max(1, Math.floor(config.starvationMs ?? 120_000));
  const maxRunningDM = Math.max(1, Math.floor(config.maxRunningDM ?? Math.max(1, totalSlots - 1)));

  const waiters: QueueEntry[] = [];
  const running = new Map<string, { source: GlobalQueueSource }>();
  let dmRunning = 0;
  let nextId = 0;

  const isEligible = (entry: QueueEntry): boolean => {
    const runningCount = running.size;
    if (runningCount >= totalSlots) {
      return false;
    }
    const nonDmWaitingCount = waiters.filter((item) => item.source !== "dm").length;
    const nonDmRunning = Math.max(0, runningCount - dmRunning);
    if (entry.source === "dm") {
      if (nonDmWaitingCount > 0) {
        if (nonDmRunning === 0) {
          if (dmRunning >= Math.max(0, maxRunningDM - 1)) {
            return false;
          }
        } else if (dmRunning >= maxRunningDM) {
          return false;
        }
      }
      return true;
    }
    return runningCount < maxConcurrent;
  };

  const releaseById = (id: string): void => {
    const info = running.get(id);
    if (!info) {
      return;
    }
    running.delete(id);
    if (info.source === "dm") {
      dmRunning = Math.max(0, dmRunning - 1);
    }
    tryDispatch();
  };

  const tryDispatch = (): void => {
    while (running.size < totalSlots && waiters.length > 0) {
      const now = nowMs();
      waiters.sort((a, b) => {
        const priorityDiff =
          effectivePriority(b, now, starvationMs) - effectivePriority(a, now, starvationMs);
        if (priorityDiff !== 0) {
          return priorityDiff;
        }
        return a.enqueuedAtMs - b.enqueuedAtMs;
      });
      const nextIndex = waiters.findIndex((entry) => isEligible(entry));
      if (nextIndex < 0) {
        return;
      }
      const entry = waiters.splice(nextIndex, 1)[0];
      running.set(entry.id, { source: entry.source });
      if (entry.source === "dm") {
        dmRunning += 1;
      }
      config.metrics?.recordAgentInvocation({ source: entry.source });
      entry.resolve({
        id: entry.id,
        source: entry.source,
        release: () => {
          releaseById(entry.id);
        },
      });
    }
  };

  return {
    acquire: async ({ source }) => {
      const id = `gq-${String(++nextId)}`;
      return await new Promise<GlobalConcurrencyLease>((resolve) => {
        waiters.push({
          id,
          source,
          basePriority: SOURCE_BASE_PRIORITY[source],
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
    getSnapshot: () => ({
      running: running.size,
      dmRunning,
      waiting: waiters.length,
      totalSlots,
      maxConcurrent,
      maxRunningDM,
    }),
  };
}
