import type { TimelineEvent } from "$lib/server/types";

export interface DaySourceOption {
  name: string;
  count: number;
  selected: boolean;
}

export interface DayPageData {
  date: string;
  events: TimelineEvent[];
  summary: string | null;
  sources: DaySourceOption[];
  clipboardTemplate: {
    source: string;
    origin: "default" | "custom";
  };
  slackWorkspaceBaseUrl: string | null;
  llm: {
    models: string[];
    defaultModel: string | null;
  };
}
