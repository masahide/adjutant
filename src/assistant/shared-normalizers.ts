const DEFAULT_TIMEZONE = process.env.ADJUTANT_TZ || "Asia/Tokyo";

export function normalizeTimezone(value: string | undefined): string {
  if (typeof value !== "string") {
    return DEFAULT_TIMEZONE;
  }
  const trimmed = value.trim();
  return trimmed || DEFAULT_TIMEZONE;
}

export function normalizeSessionKey(value: string | undefined): string {
  if (typeof value !== "string") {
    return "main";
  }
  const trimmed = value.trim();
  return trimmed || "main";
}

export function shiftDateKey(dateKey: string, days: number): string {
  const [yearRaw = "1970", monthRaw = "01", dayRaw = "01"] = dateKey.split("-");
  const year = Number.parseInt(yearRaw, 10);
  const month = Number.parseInt(monthRaw, 10);
  const day = Number.parseInt(dayRaw, 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return "1970-01-01";
  }
  const base = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}
