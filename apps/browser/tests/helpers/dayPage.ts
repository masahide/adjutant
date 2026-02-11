import type { DayPageData } from "$lib/viewModels/day";
import type { TimelineEvent } from "$lib/server/types";

export function createTimelineEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    uid: "event-1",
    source: "slack",
    ts: "2025-11-03T09:00:00+09:00",
    loggedAt: "2025-11-03T09:00:05+09:00",
    raw: {},
    ...overrides,
  };
}

export function createDayPageData(overrides: Partial<DayPageData> = {}): DayPageData {
  const base: DayPageData = {
    date: "2025-11-03",
    events: [createTimelineEvent()],
    summary: null,
    sources: [
      {
        name: "slack",
        count: 1,
        selected: true,
      },
    ],
    clipboardTemplate: {
      source: "# Template\n- item",
      origin: "default",
    },
    slackWorkspaceBaseUrl: null,
    llm: {
      models: ["gpt-4.1-mini"],
      defaultModel: "gpt-4.1-mini",
    },
  };

  return {
    ...base,
    ...overrides,
  };
}
