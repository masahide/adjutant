import type { NormalizedEvent } from "../core/events.js";
import type { SelfMessageState } from "./route-decision.js";

export type RuleTriageRoute = "drop" | "immediate" | "accumulate";

export type RuleTriageResult = {
  route: RuleTriageRoute;
  reason: string;
  isDm: boolean;
};

export type RuleTriageInput = {
  event: NormalizedEvent;
  selfState: SelfMessageState;
};

export type RuleTriage = {
  classify: (input: RuleTriageInput) => RuleTriageResult;
};

export type RuleTriageOptions = {
  mentionRegex?: RegExp;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function extractSlack(event: NormalizedEvent): Record<string, unknown> | null {
  const detail = asRecord(event.detail);
  if (!detail) {
    return null;
  }
  return asRecord(detail.slack);
}

function extractChannelId(event: NormalizedEvent): string | null {
  const slack = extractSlack(event);
  const raw = slack?.channel_id;
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = raw.trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}

function extractText(event: NormalizedEvent): string {
  const slack = extractSlack(event);
  const raw = slack?.text;
  if (typeof raw !== "string") {
    return "";
  }
  return raw;
}

function isDirectMessageChannelId(channelId: string | null): boolean {
  if (!channelId) {
    return false;
  }
  return channelId.startsWith("D");
}

export function createRuleTriage(options: RuleTriageOptions = {}): RuleTriage {
  const mentionRegex = options.mentionRegex ?? /<@[^>]+>|@you\b/i;

  return {
    classify: ({ event, selfState }) => {
      if (selfState === "self") {
        return { route: "drop", reason: "self-message", isDm: false };
      }

      if (event.kind !== "post") {
        return { route: "accumulate", reason: "non-post-event", isDm: false };
      }

      const channelId = extractChannelId(event);
      const isDm = isDirectMessageChannelId(channelId);
      if (isDm) {
        return { route: "immediate", reason: "direct-message", isDm: true };
      }

      const text = extractText(event);
      if (mentionRegex.test(text)) {
        return { route: "immediate", reason: "mention", isDm: false };
      }

      return { route: "accumulate", reason: "channel-post", isDm: false };
    },
  };
}
