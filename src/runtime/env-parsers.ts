export function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
}

export function parseStringEnv(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    return fallback;
  }
  return normalized;
}

export function parseNumberEnv(
  value: string | undefined,
  fallback: number,
  options?: { min?: number; max?: number }
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const min = options?.min;
  const max = options?.max;
  let result = parsed;
  if (typeof min === "number") {
    result = Math.max(min, result);
  }
  if (typeof max === "number") {
    result = Math.min(max, result);
  }
  return result;
}

export function parseIntEnv(
  value: string | undefined,
  fallback: number,
  options?: { min?: number; max?: number }
): number {
  return Math.floor(parseNumberEnv(value, fallback, options));
}

export function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

export function parseNonNegativeIntEnv(value: string | undefined, fallback: number): number {
  return parseIntEnv(value, fallback, { min: 0 });
}
