const dateFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  dateStyle: "medium",
});

const timestampFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  dateStyle: "medium",
  timeStyle: "medium",
});

const timeFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  timeStyle: "short",
});

const promptTimestampFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const JST_OFFSET = "+09:00";

export function formatIsoDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return dateFormatter.format(new Date(year, (month ?? 1) - 1, day));
}

export function formatIsoTimestamp(value: string): string {
  return timestampFormatter.format(new Date(value));
}

export function formatEventTime(value: string | null, fallbackDate?: string): string {
  if (value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return timeFormatter.format(new Date(parsed));
    }
  }
  if (fallbackDate) {
    const [year, month, day] = fallbackDate.split("-").map(Number);
    return timeFormatter.format(new Date(year, (month ?? 1) - 1, day));
  }
  return "--:--";
}

export function formatEventTimestampJstIso(value: string | null, fallbackDate?: string): string {
  const timestamp = getTimestampFromValue(value);
  if (timestamp) {
    return timestamp;
  }

  const fallbackTimestamp = getTimestampFromFallbackDate(fallbackDate);
  if (fallbackTimestamp) {
    return fallbackTimestamp;
  }

  return formatPromptTimestamp(new Date());
}

function getTimestampFromValue(value: string | null): string | null {
  if (value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return formatPromptTimestamp(new Date(parsed));
    }
  }
  return null;
}

function getTimestampFromFallbackDate(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return null;
  }

  return `${normalized}T00:00:00${JST_OFFSET}`;
}

function formatPromptTimestamp(date: Date): string {
  let yearPart = "0000";
  let monthPart = "01";
  let dayPart = "01";
  let hourPart = "00";
  let minutePart = "00";
  let secondPart = "00";

  for (const part of promptTimestampFormatter.formatToParts(date)) {
    switch (part.type) {
      case "year":
        yearPart = part.value;
        break;
      case "month":
        monthPart = part.value;
        break;
      case "day":
        dayPart = part.value;
        break;
      case "hour":
        hourPart = part.value;
        break;
      case "minute":
        minutePart = part.value;
        break;
      case "second":
        secondPart = part.value;
        break;
      default:
        break;
    }
  }

  return `${yearPart}-${monthPart}-${dayPart}T${hourPart}:${minutePart}:${secondPart}${JST_OFFSET}`;
}
