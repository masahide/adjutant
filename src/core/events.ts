export type EventCore = {
  schema: "reaclog.event.v1.1";
  uid: string;
  source: "slack" | "github" | "git-local";
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
};

export type SlackDetail = SlackPostDetail | SlackReactionDetail;

export type EventDetail =
  | { slack: SlackDetail }
  | { github: Record<string, unknown> }
  | { git_local: Record<string, unknown> };

export type NormalizedEvent = EventCore & { detail?: EventDetail };
