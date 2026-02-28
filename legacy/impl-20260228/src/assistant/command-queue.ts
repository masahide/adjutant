const MAIN_LANE = "main";
const DEFAULT_WAIT_WARN_AFTER_MS = 2_000;
const laneConcurrencyOverrides = new Map<string, number>();

export type CommandFn<T> = () => Promise<T>;

export type CommandQueueOptions = {
  lane?: string;
  warnAfterMs?: number;
  onWait?: (warning: QueueWaitWarning) => void;
};

export type LaneQueueOptions = {
  warnAfterMs?: number;
  onWait?: (warning: QueueWaitWarning) => void;
};

export type QueueWaitWarning = {
  lane: string;
  waitMs: number;
  queuedAhead: number;
};

type QueueEntry<T = unknown> = {
  fn: CommandFn<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  warnAfterMs: number;
  onWait?: (warning: QueueWaitWarning) => void;
};

type LaneState = {
  active: number;
  maxConcurrent: number;
  draining: boolean;
  queue: QueueEntry[];
};

const lanes = new Map<string, LaneState>();

function normalizeLane(lane?: string): string {
  if (!lane) {
    return MAIN_LANE;
  }
  const cleaned = lane.trim();
  return cleaned || MAIN_LANE;
}

function getOrCreateLane(lane: string): LaneState {
  const existing = lanes.get(lane);
  if (existing) {
    return existing;
  }
  const created: LaneState = {
    active: 0,
    maxConcurrent: laneConcurrencyOverrides.get(lane) ?? 1,
    draining: false,
    queue: [],
  };
  lanes.set(lane, created);
  return created;
}

function maybeCleanupLane(lane: string): void {
  const state = lanes.get(lane);
  if (!state) {
    return;
  }
  if (!state.draining && state.active === 0 && state.queue.length === 0) {
    lanes.delete(lane);
  }
}

function drainLane(lane: string): void {
  const state = getOrCreateLane(lane);
  if (state.draining) {
    return;
  }
  state.draining = true;

  const pump = () => {
    while (state.active < state.maxConcurrent && state.queue.length > 0) {
      const entry = state.queue.shift() as QueueEntry;
      const waitedMs = Date.now() - entry.enqueuedAt;
      if (waitedMs >= entry.warnAfterMs) {
        entry.onWait?.({
          lane,
          waitMs: waitedMs,
          queuedAhead: state.queue.length,
        });
      }

      state.active += 1;
      void (async () => {
        try {
          const value = await entry.fn();
          entry.resolve(value);
        } catch (error) {
          entry.reject(error);
        } finally {
          state.active -= 1;
          pump();
          maybeCleanupLane(lane);
        }
      })();
    }
    state.draining = false;
    maybeCleanupLane(lane);
  };

  pump();
}

export function resolveSessionLane(sessionKey: string): string {
  const cleaned = sessionKey.trim() || MAIN_LANE;
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

function resolveWarnAfterMs(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_WAIT_WARN_AFTER_MS;
  }
  return Math.max(1, Math.floor(value as number));
}

export function setCommandLaneConcurrency(lane: string, maxConcurrent: number): void {
  const laneKey = normalizeLane(lane);
  const state = getOrCreateLane(laneKey);
  const normalized =
    Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? Math.floor(maxConcurrent) : 1;
  laneConcurrencyOverrides.set(laneKey, normalized);
  state.maxConcurrent = normalized;
  drainLane(laneKey);
}

export class CommandQueueClearedError extends Error {
  lane: string;

  constructor(lane: string) {
    super(`command lane cleared: ${lane}`);
    this.name = "CommandQueueClearedError";
    this.lane = lane;
  }
}

export function clearCommandLane(lane: string = MAIN_LANE): number {
  const laneKey = normalizeLane(lane);
  const state = lanes.get(laneKey);
  if (!state || state.queue.length === 0) {
    maybeCleanupLane(laneKey);
    return 0;
  }

  const error = new CommandQueueClearedError(laneKey);
  const removedEntries = state.queue.splice(0, state.queue.length);
  for (const entry of removedEntries) {
    entry.reject(error);
  }
  maybeCleanupLane(laneKey);
  return removedEntries.length;
}

export function enqueueCommandInLane<T>(
  lane: string,
  fn: CommandFn<T>,
  opts?: LaneQueueOptions
): Promise<T> {
  const laneKey = normalizeLane(lane);
  const state = getOrCreateLane(laneKey);
  return new Promise<T>((resolve, reject) => {
    state.queue.push({
      fn: () => fn(),
      resolve: (value) => resolve(value as T),
      reject,
      enqueuedAt: Date.now(),
      warnAfterMs: resolveWarnAfterMs(opts?.warnAfterMs),
      onWait: opts?.onWait,
    });
    drainLane(laneKey);
  });
}

export function enqueueCommand<T>(fn: CommandFn<T>, opts?: CommandQueueOptions): Promise<T> {
  return enqueueCommandInLane(opts?.lane ?? MAIN_LANE, fn, opts);
}

export function getQueueSize(lane: string = MAIN_LANE): number {
  const laneKey = normalizeLane(lane);
  const state = lanes.get(laneKey);
  if (!state) {
    return 0;
  }
  return state.queue.length + state.active;
}

export function isIdle(lane: string = MAIN_LANE): boolean {
  return getQueueSize(lane) === 0;
}

export function isGlobalIdle(): boolean {
  for (const [lane] of lanes) {
    if (!isIdle(lane)) {
      return false;
    }
  }
  return true;
}

export function resetCommandQueueForTest(): void {
  lanes.clear();
  laneConcurrencyOverrides.clear();
}
