const MAIN_LANE = "main";

export type CommandFn<T> = () => Promise<T>;

export type CommandQueueOptions = {
  lane?: string;
};

type QueueEntry<T = unknown> = {
  fn: CommandFn<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

type LaneState = {
  active: boolean;
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
    active: false,
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
  if (!state.active && state.queue.length === 0) {
    lanes.delete(lane);
  }
}

function drainLane(lane: string): void {
  const state = getOrCreateLane(lane);
  if (state.active) {
    return;
  }

  const entry = state.queue.shift();
  if (!entry) {
    maybeCleanupLane(lane);
    return;
  }

  state.active = true;
  void (async () => {
    try {
      const value = await entry.fn();
      state.active = false;
      if (state.queue.length === 0) {
        maybeCleanupLane(lane);
      }
      drainLane(lane);
      entry.resolve(value);
    } catch (error) {
      state.active = false;
      if (state.queue.length === 0) {
        maybeCleanupLane(lane);
      }
      drainLane(lane);
      entry.reject(error);
    }
  })();
}

export function resolveSessionLane(sessionKey: string): string {
  const cleaned = sessionKey.trim() || MAIN_LANE;
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

export function enqueueCommandInLane<T>(lane: string, fn: CommandFn<T>): Promise<T> {
  const laneKey = normalizeLane(lane);
  const state = getOrCreateLane(laneKey);
  return new Promise<T>((resolve, reject) => {
    state.queue.push({
      fn: () => fn(),
      resolve: (value) => resolve(value as T),
      reject,
    });
    drainLane(laneKey);
  });
}

export function enqueueCommand<T>(fn: CommandFn<T>, opts?: CommandQueueOptions): Promise<T> {
  return enqueueCommandInLane(opts?.lane ?? MAIN_LANE, fn);
}

export function getQueueSize(lane: string = MAIN_LANE): number {
  const laneKey = normalizeLane(lane);
  const state = lanes.get(laneKey);
  if (!state) {
    return 0;
  }
  return state.queue.length + (state.active ? 1 : 0);
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
}
