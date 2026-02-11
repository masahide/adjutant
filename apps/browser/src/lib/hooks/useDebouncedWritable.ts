import { writable, type Writable } from "svelte/store";

export function useDebouncedWritable<T>(
  initialValue: T,
  options: { delay?: number; onFlush?: (value: T) => void } = {}
): Writable<T> & { flush: () => void } {
  const { delay = 500, onFlush } = options;
  const inner = writable(initialValue);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastValue = initialValue;

  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = () => {
    cancel();
    onFlush?.(lastValue);
  };

  const { subscribe } = inner;
  const set = (value: T) => {
    lastValue = value;
    inner.set(value);
    cancel();
    if (delay <= 0) {
      flush();
      return;
    }
    timer = setTimeout(flush, delay);
  };

  const update: Writable<T>["update"] = (updater) => {
    const next = updater(lastValue);
    set(next);
  };

  return {
    subscribe,
    set,
    update,
    flush,
  };
}
