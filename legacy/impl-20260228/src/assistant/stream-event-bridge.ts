import type { StreamEvent } from "./types.js";

type RunState = {
  events: StreamEvent[];
  terminal: StreamEvent | null;
  completedAt: number | null;
  listeners: Set<(event: StreamEvent) => void>;
};

type ReplayConfig = {
  maxEventsPerRun: number;
  maxAgeMs: number;
};

type ReplayStatus =
  | { status: "ok" }
  | { status: "expired"; minAvailableSeq: number; maxAvailableSeq: number };

type SubscribeOptions = {
  afterSeq?: number;
};

const DEFAULT_CONFIG: ReplayConfig = {
  maxEventsPerRun: 512,
  maxAgeMs: 300_000,
};

const runs = new Map<string, RunState>();
let replayConfig: ReplayConfig = { ...DEFAULT_CONFIG };

function getOrCreateRun(runId: string): RunState {
  let state = runs.get(runId);
  if (!state) {
    state = { events: [], terminal: null, completedAt: null, listeners: new Set() };
    runs.set(runId, state);
  }
  return state;
}

function isTerminal(state: StreamEvent["state"]): boolean {
  return state === "final" || state === "aborted" || state === "error";
}

function trimRunEvents(run: RunState): void {
  if (run.events.length <= replayConfig.maxEventsPerRun) {
    return;
  }
  const overflow = run.events.length - replayConfig.maxEventsPerRun;
  run.events.splice(0, overflow);
}

function getSeqBounds(run: RunState): { min: number; max: number } | null {
  if (run.events.length === 0) {
    return null;
  }
  return {
    min: run.events[0]!.seq,
    max: run.events[run.events.length - 1]!.seq,
  };
}

function resolveReplayStatus(run: RunState, afterSeq: number): ReplayStatus {
  const bounds = getSeqBounds(run);
  if (!bounds) {
    return { status: "ok" };
  }
  if (afterSeq < bounds.min - 1) {
    return {
      status: "expired",
      minAvailableSeq: bounds.min,
      maxAvailableSeq: bounds.max,
    };
  }
  return { status: "ok" };
}

export function configureReplay(opts: Partial<ReplayConfig>): void {
  replayConfig = {
    maxEventsPerRun:
      Number.isFinite(opts.maxEventsPerRun) && (opts.maxEventsPerRun as number) > 0
        ? Math.max(1, Math.floor(opts.maxEventsPerRun as number))
        : replayConfig.maxEventsPerRun,
    maxAgeMs:
      Number.isFinite(opts.maxAgeMs) && (opts.maxAgeMs as number) > 0
        ? Math.max(1, Math.floor(opts.maxAgeMs as number))
        : replayConfig.maxAgeMs,
  };
}

export function emit(event: StreamEvent): void {
  const run = getOrCreateRun(event.runId);
  if (run.terminal) {
    return;
  }
  run.events.push(event);
  trimRunEvents(run);
  if (isTerminal(event.state)) {
    run.terminal = event;
    run.completedAt = Date.now();
  }
  for (const listener of run.listeners) {
    listener(event);
  }
}

export function subscribe(
  runId: string,
  opts: SubscribeOptions = {}
): {
  events: AsyncIterable<StreamEvent>;
  unsubscribe: () => void;
  replay: ReplayStatus;
} {
  const run = getOrCreateRun(runId);
  const afterSeq = Number.isFinite(opts.afterSeq) ? Math.floor(opts.afterSeq as number) : null;
  const replay =
    afterSeq === null ? ({ status: "ok" } as const) : resolveReplayStatus(run, afterSeq);
  if (replay.status === "expired") {
    return {
      events: {
        [Symbol.asyncIterator]() {
          return {
            next: async () => ({ value: undefined as unknown as StreamEvent, done: true }),
          };
        },
      },
      unsubscribe: () => {},
      replay,
    };
  }

  const pending = run.events.filter((event) => (afterSeq === null ? true : event.seq > afterSeq));
  let resolve: ((value: IteratorResult<StreamEvent>) => void) | null = null;
  let done = run.terminal ? pending.length === 0 : false;

  const listener = (event: StreamEvent) => {
    if (done) return;
    if (resolve) {
      const r = resolve;
      resolve = null;
      r({ value: event, done: false });
    } else {
      pending.push(event);
    }
  };

  if (!run.terminal) {
    run.listeners.add(listener);
  }

  const events: AsyncIterable<StreamEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<StreamEvent>> {
          if (pending.length > 0) {
            const event = pending.shift()!;
            if (isTerminal(event.state)) {
              done = true;
            }
            return Promise.resolve({ value: event, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined as unknown as StreamEvent, done: true });
          }
          return new Promise<IteratorResult<StreamEvent>>((r) => {
            resolve = (result) => {
              if (!result.done && isTerminal(result.value.state)) {
                done = true;
              }
              r(result);
            };
          });
        },
        return(): Promise<IteratorResult<StreamEvent>> {
          done = true;
          run.listeners.delete(listener);
          return Promise.resolve({ value: undefined as unknown as StreamEvent, done: true });
        },
      };
    },
  };

  const unsubscribe = () => {
    done = true;
    run.listeners.delete(listener);
    if (resolve) {
      const r = resolve;
      resolve = null;
      r({ value: undefined as unknown as StreamEvent, done: true });
    }
  };

  return { events, unsubscribe, replay };
}

export function getTerminal(runId: string): StreamEvent | null {
  return runs.get(runId)?.terminal ?? null;
}

export function hasRun(runId: string): boolean {
  return runs.has(runId);
}

export function cleanup(maxAgeMs: number = replayConfig.maxAgeMs): number {
  const now = Date.now();
  let removed = 0;
  for (const [runId, state] of runs) {
    if (state.completedAt && state.listeners.size === 0 && now - state.completedAt >= maxAgeMs) {
      runs.delete(runId);
      removed++;
    }
  }
  return removed;
}

export function resetForTest(): void {
  for (const run of runs.values()) {
    run.listeners.clear();
  }
  runs.clear();
  replayConfig = { ...DEFAULT_CONFIG };
}
