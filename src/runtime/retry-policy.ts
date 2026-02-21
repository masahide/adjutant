type FullJitterOptions = {
  attempt: number;
  baseMs: number;
  capMs: number;
  random?: () => number;
};

function normalizeMs(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function clampRandom(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

export function computeFullJitterDelayMs(opts: FullJitterOptions): number {
  const attempt = Math.max(1, Math.floor(opts.attempt));
  const baseMs = normalizeMs(opts.baseMs, 1000);
  const capMs = Math.max(normalizeMs(opts.capMs, 10000), baseMs);
  const random = opts.random ?? Math.random;
  const maxDelay = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(clampRandom(random()) * maxDelay);
}
