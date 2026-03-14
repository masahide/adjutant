export type EventSource = "slack" | "github" | "git-local";

export type EventCore = {
  schema: "adjutant.event.v1.1";
  uid: string;
  source: EventSource;
  kind: string;
  action?: string;
  actor?: string;
  subject?: string;
  ts: string;
  logged_at?: string;
  meta?: Record<string, unknown>;
};

export type SlackPostDetail = {
  channel_id: string;
  channel_name?: string;
  message_ts?: string;
  text?: string;
  blocks?: unknown;
  thread_ts?: string;
};

export type SlackReactionDetail = {
  message_ts: string;
  channel_id: string;
  channel_name?: string;
  emoji?: string;
  user?: string;
  message_text?: string;
  thread_ts?: string;
};

export type SlackNotificationDetail = {
  team_id?: string;
  workspace_host?: string;
  channel_id?: string;
  channel_name?: string;
  notification_type: string;
  title?: string;
  message_text?: string;
  user?: string;
  event_ts?: string;
  message_ts?: string;
  thread_ts?: string;
  permalink?: string;
  mention_target_user_id?: string;
  is_direct_mention?: boolean;
};

export type SlackDetail = SlackPostDetail | SlackReactionDetail | SlackNotificationDetail;

export type EventDetail =
  | { slack: SlackDetail }
  | { github: Record<string, unknown> }
  | { git_local: Record<string, unknown> };

export type NormalizedEvent = EventCore & { detail?: EventDetail };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isEventSource(value: unknown): value is EventSource {
  return value === "slack" || value === "github" || value === "git-local";
}

export function isNormalizedEvent(value: unknown): value is NormalizedEvent {
  if (!isObject(value)) {
    return false;
  }

  if (value.schema !== "adjutant.event.v1.1") {
    return false;
  }
  if (!isString(value.uid) || value.uid.length === 0) {
    return false;
  }
  if (!isEventSource(value.source)) {
    return false;
  }
  if (!isString(value.kind) || value.kind.length === 0) {
    return false;
  }
  if (!isString(value.ts) || !value.ts.includes("T")) {
    return false;
  }

  if ("detail" in value && value.detail !== undefined && !isObject(value.detail)) {
    return false;
  }

  return true;
}

export function isSlackNormalizedEvent(value: unknown): value is NormalizedEvent {
  if (!isNormalizedEvent(value)) {
    return false;
  }
  return value.source === "slack";
}
