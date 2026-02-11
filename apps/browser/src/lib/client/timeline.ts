import type { TimelineEvent } from "$lib/server/types";
import type { DaySourceOption } from "$lib/viewModels/day";

export function insertEvent(list: TimelineEvent[], incoming: TimelineEvent): TimelineEvent[] {
  if (list.some((event) => event.uid === incoming.uid)) {
    return list;
  }
  const next = [...list, incoming];
  next.sort(compareEvents);
  return next;
}

export function computeLastTimestamp(list: TimelineEvent[], fallbackDate: string): string {
  if (list.length === 0) {
    return `${fallbackDate}T00:00:00`;
  }
  const last = list[list.length - 1];
  return last.loggedAt ?? last.ts ?? `${fallbackDate}T00:00:00`;
}

export function accumulateSource(
  list: DaySourceOption[],
  sourceName: string
): { options: DaySourceOption[]; added?: string } {
  const next = list.map((entry) => ({ ...entry }));
  const index = next.findIndex((entry) => entry.name === sourceName);
  if (index >= 0) {
    next[index].count += 1;
    return { options: next };
  }

  const addition: DaySourceOption = {
    name: sourceName,
    count: 1,
    selected: true,
  };
  next.push(addition);
  next.sort((a, b) => a.name.localeCompare(b.name));
  return { options: next, added: sourceName };
}

export function parseTimelineEvent(payload: string): TimelineEvent | null {
  try {
    const parsed = JSON.parse(payload) as TimelineEvent;
    if (parsed && typeof parsed.uid === "string") {
      return parsed;
    }
  } catch {
    // ignore malformed payload
  }
  return null;
}

function compareEvents(a: TimelineEvent, b: TimelineEvent): number {
  const diff = getTimestamp(a) - getTimestamp(b);
  if (diff !== 0) {
    return diff;
  }
  return a.uid.localeCompare(b.uid);
}

function getTimestamp(event: TimelineEvent): number {
  const value = event.loggedAt ?? event.ts;
  if (!value) {
    return Number.MAX_SAFE_INTEGER;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}
