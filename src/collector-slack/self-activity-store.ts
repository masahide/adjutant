import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { NormalizedEvent } from "../core/events.js";

export type SelfActivityRecord = {
  schema: "adjutant.self-activity.v1";
  kind: "self_post" | "self_reaction";
  logged_at: string;
  channel_id?: string;
  message_ts?: string;
  thread_ts?: string;
  message_text?: string;
  emoji?: string;
  action?: string;
  event: NormalizedEvent;
};

export type SelfActivityStoreOptions = {
  dataDir: string;
  now?: () => Date;
};

export class SelfActivityStore {
  private readonly now: () => Date;

  constructor(private readonly options: SelfActivityStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async append(event: NormalizedEvent): Promise<void> {
    const record = toSelfActivityRecord(event, this.now);
    if (!record) {
      return;
    }
    const filePath = resolve(
      this.options.dataDir,
      "state",
      "activity",
      "self",
      `${extractDateKey(record.logged_at, this.now)}.jsonl`
    );
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
  }
}

export function toSelfActivityRecord(
  event: NormalizedEvent,
  now: () => Date = () => new Date()
): SelfActivityRecord | null {
  if (event.source !== "slack") {
    return null;
  }
  if (event.kind !== "post" && event.kind !== "reaction") {
    return null;
  }
  const slack = getSlackDetail(event);
  const loggedAt = normalizeLoggedAt(event.logged_at, now);
  return {
    schema: "adjutant.self-activity.v1",
    kind: event.kind === "post" ? "self_post" : "self_reaction",
    logged_at: loggedAt,
    channel_id: asString(slack?.channel_id),
    message_ts: asString(slack?.message_ts),
    thread_ts: asString(slack?.thread_ts),
    message_text: pickMessageText(event.kind, slack),
    emoji: asString(slack?.emoji),
    action: typeof event.action === "string" ? event.action : undefined,
    event,
  };
}

function pickMessageText(kind: string, slack: Record<string, unknown> | null): string | undefined {
  if (!slack) {
    return undefined;
  }
  if (kind === "post") {
    return asString(slack.text);
  }
  return asString(slack.message_text);
}

function getSlackDetail(event: NormalizedEvent): Record<string, unknown> | null {
  const detail = event.detail;
  if (!detail || typeof detail !== "object" || !("slack" in detail)) {
    return null;
  }
  const slack = detail.slack;
  if (!slack || typeof slack !== "object" || Array.isArray(slack)) {
    return null;
  }
  return slack as Record<string, unknown>;
}

function normalizeLoggedAt(value: string | undefined, now: () => Date): string {
  if (typeof value === "string" && value.includes("T")) {
    return value;
  }
  return now().toISOString();
}

function extractDateKey(value: string, now: () => Date): string {
  const iso = value && value.includes("T") ? value : now().toISOString();
  return iso.split("T")[0] ?? "1970-01-01";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
