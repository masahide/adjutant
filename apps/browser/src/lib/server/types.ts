export interface ReadDailyEventsOptions {
  dataDir: string;
  date: string; // yyyy-mm-dd
  cache?: boolean;
}

export interface TimelineEvent {
  uid: string;
  source: string;
  ts: string | null;
  loggedAt: string | null;
  raw: Record<string, unknown>;
}

export interface DailyEventsResult {
  events: TimelineEvent[];
  bySource: Record<string, number>;
}

export interface ReadDailySummaryOptions {
  dataDir: string;
  date: string;
  cache?: boolean;
}
