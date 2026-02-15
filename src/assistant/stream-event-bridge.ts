import type { StreamEvent } from "./types.js";

type RunState = {
  events: StreamEvent[];
  terminal: StreamEvent | null;
  completedAt: number | null;
  listeners: Set<(event: StreamEvent) => void>;
};

const runs = new Map<string, RunState>();

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

export function emit(event: StreamEvent): void {
  const run = getOrCreateRun(event.runId);
  if (run.terminal) {
    return;
  }
  run.events.push(event);
  if (isTerminal(event.state)) {
    run.terminal = event;
    run.completedAt = Date.now();
  }
  for (const listener of run.listeners) {
    listener(event);
  }
}

export function subscribe(runId: string): {
  events: AsyncIterable<StreamEvent>;
  unsubscribe: () => void;
} {
  const run = getOrCreateRun(runId);
  let resolve: ((value: IteratorResult<StreamEvent>) => void) | null = null;
  let done = false;
  const pending: StreamEvent[] = [];

  if (run.terminal) {
    pending.push(...run.events);
  }

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

  return { events, unsubscribe };
}

export function getTerminal(runId: string): StreamEvent | null {
  return runs.get(runId)?.terminal ?? null;
}

export function hasRun(runId: string): boolean {
  return runs.has(runId);
}

export function cleanup(maxAgeMs: number = 300_000): number {
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
}
