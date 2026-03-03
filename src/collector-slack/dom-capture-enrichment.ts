import type { NormalizedEvent } from "../core/events.js";

export type ReactionDomCaptureResult = {
  text?: string | null;
  channelId?: string | null;
  channelName?: string | null;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function enrichReactionEventWithDomCapture(
  event: NormalizedEvent,
  capture: ReactionDomCaptureResult | null
): NormalizedEvent {
  if (event.kind !== "reaction") {
    return event;
  }
  if (capture === null) {
    return event;
  }
  if (!isObject(event.detail) || !("slack" in event.detail)) {
    return event;
  }
  const slack = event.detail.slack;
  if (!isObject(slack)) {
    return event;
  }

  const capturedText = asNonEmptyString(capture.text);
  const capturedChannelId = asNonEmptyString(capture.channelId);
  const capturedChannelName = asNonEmptyString(capture.channelName);

  if (
    capturedText === undefined &&
    capturedChannelId === undefined &&
    capturedChannelName === undefined
  ) {
    return event;
  }

  const nextSlack = { ...(slack as Record<string, unknown>) };
  if (capturedText !== undefined) {
    nextSlack.message_text = capturedText;
  }
  if (capturedChannelId !== undefined && asNonEmptyString(slack.channel_id) === undefined) {
    nextSlack.channel_id = capturedChannelId;
  }
  if (capturedChannelName !== undefined && asNonEmptyString(slack.channel_name) === undefined) {
    nextSlack.channel_name = capturedChannelName;
  }

  return {
    ...event,
    detail: {
      ...event.detail,
      slack: nextSlack as typeof slack,
    },
  };
}
