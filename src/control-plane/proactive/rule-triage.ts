import type { NormalizedEvent } from "../../core/events.js";

export type RuleTriageRoute = "drop" | "immediate" | "accumulate";
export type ProactiveSource = "dm" | "group" | "channel" | "flusher" | "heartbeat";

export type RuleTriageResult = {
  route: RuleTriageRoute;
  reason: string;
  source: ProactiveSource;
  isDm: boolean;
};

export type RuleTriageInput = {
  sessionKey: string;
  event: NormalizedEvent;
};

export type RuleTriage = {
  classify: (input: RuleTriageInput) => RuleTriageResult;
};

export type RuleTriageOptions = {
  selfUserId?: string;
  mentionRegex?: RegExp;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function extractSlackDetail(event: NormalizedEvent): Record<string, unknown> {
  if (!isObject(event.detail)) {
    return {};
  }
  if (!("slack" in event.detail) || !isObject(event.detail.slack)) {
    return {};
  }
  return event.detail.slack;
}

function extractChannelId(event: NormalizedEvent): string | undefined {
  return asString(extractSlackDetail(event).channel_id);
}

function extractText(event: NormalizedEvent): string {
  const detail = extractSlackDetail(event);
  return asString(detail.text) ?? asString(detail.message_text) ?? "";
}

function extractActor(event: NormalizedEvent): string | undefined {
  const detail = extractSlackDetail(event);
  return asString(event.actor) ?? asString(detail.user);
}

function resolveSource(channelId: string | undefined): ProactiveSource {
  if (channelId?.startsWith("D")) {
    return "dm";
  }
  if (channelId?.startsWith("G")) {
    return "group";
  }
  return "channel";
}

export function createRuleTriage(options: RuleTriageOptions = {}): RuleTriage {
  const mentionRegex = options.mentionRegex ?? /<@[^>]+>|@you\b/i;
  const selfUserId = asString(options.selfUserId);

  return {
    classify: ({ event }) => {
      const channelId = extractChannelId(event);
      const source = resolveSource(channelId);
      const actor = extractActor(event);
      if (selfUserId !== undefined && actor === selfUserId) {
        return {
          route: "drop",
          reason: "self-message",
          source,
          isDm: source === "dm",
        };
      }

      if (source === "dm") {
        return {
          route: "immediate",
          reason: "direct-message",
          source,
          isDm: true,
        };
      }

      const text = extractText(event);
      if (event.kind === "post" && mentionRegex.test(text)) {
        return {
          route: "immediate",
          reason: "mention",
          source,
          isDm: false,
        };
      }

      return {
        route: "accumulate",
        reason: "default-accumulate",
        source,
        isDm: false,
      };
    },
  };
}
