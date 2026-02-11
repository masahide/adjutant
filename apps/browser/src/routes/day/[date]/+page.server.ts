import { readDailyEvents, readDailySummary } from "$lib/server/data";
import { resolveDataDir, resolveSlackWorkspaceBaseUrl } from "$lib/server/config";
import { loadLlmConfig } from "$lib/server/llmConfig";
import { loadClipboardTemplate } from "$lib/server/clipboardTemplate";
import type { TimelineEvent } from "$lib/server/types";
import type { DayPageData, DaySourceOption } from "$lib/viewModels/day";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
  event.depends?.("reaclog:day");
  const date = event.params.date;
  if (!date) {
    return {
      date: "",
      events: [],
      summary: null,
      sources: [],
      clipboardTemplate: {
        source: "",
        origin: "default",
      },
      slackWorkspaceBaseUrl: resolveSlackWorkspaceBaseUrl(),
      llm: {
        models: [],
        defaultModel: null,
      },
    } satisfies DayPageData;
  }

  const dataDir = resolveDataDir();
  const slackWorkspaceBaseUrl = resolveSlackWorkspaceBaseUrl();
  const [eventsResult, summary, template, llmConfig] = await Promise.all([
    readDailyEvents({ dataDir, date }),
    readDailySummary({ dataDir, date }),
    loadClipboardTemplate(),
    loadLlmConfig(),
  ]);

  const sourceCounts = eventsResult.bySource;
  const availableSources = Object.keys(sourceCounts).sort();

  const requestedSources = extractRequestedSources(event.url.searchParams);
  const selectedSources = normalizeSelectedSources(requestedSources, availableSources);
  const filteredEvents = filterEvents(eventsResult.events, selectedSources);

  const sources: DaySourceOption[] = availableSources.map((name) => ({
    name,
    count: sourceCounts[name] ?? 0,
    selected: selectedSources.length === 0 ? true : selectedSources.includes(name),
  }));

  return {
    date,
    events: filteredEvents,
    summary,
    sources,
    clipboardTemplate: {
      source: template.source,
      origin: template.origin,
    },
    slackWorkspaceBaseUrl,
    llm: {
      models: llmConfig.models,
      defaultModel: llmConfig.defaultModel,
    },
  } satisfies DayPageData;
};

function extractRequestedSources(search: URLSearchParams): string[] {
  const values = search.getAll("source").filter(Boolean);
  return values.map((value) => value.toLowerCase());
}

function normalizeSelectedSources(requested: string[], available: string[]): string[] {
  const unique = new Set<string>();
  requested.forEach((item) => {
    if (available.includes(item)) {
      unique.add(item);
    }
  });

  if (unique.size === 0) {
    return available;
  }

  return Array.from(unique.values());
}

function filterEvents(events: TimelineEvent[], selectedSources: string[]): TimelineEvent[] {
  if (selectedSources.length === 0) {
    return events;
  }
  return events.filter((event) => selectedSources.includes(event.source));
}
