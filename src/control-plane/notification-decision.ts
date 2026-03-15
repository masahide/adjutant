import type { IngestProjection } from "./process-rpc/ingest-projection.js";

export type NotificationDecisionAction = "no_action" | "draft_reply" | "needs_review";

export type NotificationDecision = {
  action: NotificationDecisionAction;
  reason?: string;
  replyText?: string;
  reviewNotes?: string;
};

export type NotificationDecisionToolCall = {
  toolName?: string;
  status?: string;
  result?: string;
  rawInput?: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asAction(value: unknown): NotificationDecisionAction | undefined {
  return value === "no_action" || value === "draft_reply" || value === "needs_review"
    ? value
    : undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = fenced ? [fenced[1] ?? "", trimmed] : [trimmed];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isObject(parsed)) {
        return parsed;
      }
    } catch {
      // ignore parse failure
    }
  }
  return undefined;
}

function normalizeDecision(input: Record<string, unknown>): NotificationDecision | undefined {
  const action = asAction(input.action);
  if (action === undefined) {
    return undefined;
  }
  const reason = asString(input.reason);
  const replyText = asString(input.replyText);
  const reviewNotes = asString(input.reviewNotes);

  if (action === "draft_reply" && replyText === undefined) {
    return undefined;
  }
  if (action === "no_action") {
    return { action, reason };
  }
  if (action === "draft_reply") {
    return { action, reason, replyText };
  }
  return { action, reason, replyText, reviewNotes };
}

function isToolHubSlackSearchRawInput(rawInput: unknown): boolean {
  if (!isObject(rawInput)) {
    return false;
  }
  return rawInput.provider === "slack" && rawInput.action === "search";
}

export function parseNotificationDecision(
  text: string,
  options: { toolCalls?: Iterable<NotificationDecisionToolCall> } = {}
): NotificationDecision {
  const parsed = parseJsonObject(text);
  let decision: NotificationDecision | undefined;
  if (parsed !== undefined) {
    const normalized = normalizeDecision(parsed);
    if (normalized !== undefined) {
      decision = normalized;
    }
  }

  if (decision === undefined) {
    const fallback = text.trim();
    decision = {
      action: "needs_review",
      reviewNotes: fallback.length > 0 ? fallback : "notification decision could not be parsed",
    };
  }

  return applyToolFailureFallback(decision, options.toolCalls);
}

function slackDetail(projection: IngestProjection): Record<string, unknown> {
  const detail = projection.rawEvent.detail;
  if (!isObject(detail) || !("slack" in detail) || !isObject(detail.slack)) {
    return {};
  }
  return detail.slack;
}

function slackMeta(projection: IngestProjection): Record<string, unknown> {
  return isObject(projection.rawEvent.meta) ? projection.rawEvent.meta : {};
}

function deriveWorkspaceUrl(
  permalink: string | undefined,
  workspaceHost: string | undefined
): string | undefined {
  if (permalink) {
    try {
      const url = new URL(permalink);
      return `${url.protocol}//${url.host}`;
    } catch {
      // ignore invalid permalink and fall back to workspaceHost
    }
  }
  return workspaceHost ? `https://${workspaceHost}` : undefined;
}

export function buildNotificationDecisionPrompt(projection: IngestProjection): string {
  const slack = slackDetail(projection);
  const title = asString(slack.title) ?? "";
  const messageText = asString(slack.message_text) ?? projection.rawEvent.subject ?? "";
  const channelId = asString(slack.channel_id) ?? "unknown";
  const messageTs = asString(slack.message_ts);
  const threadTs = asString(slack.thread_ts);
  const permalink = asString(slack.permalink);
  const workspaceHost =
    asString(slack.workspace_host) ?? asString(slackMeta(projection).workspace_host);
  const workspaceUrl = deriveWorkspaceUrl(permalink, workspaceHost);
  const workspaceUrlJson = workspaceUrl !== undefined ? `,"workspaceUrl":"${workspaceUrl}"` : "";
  const permalinkJson = permalink !== undefined ? `,"permalink":"${permalink}"` : "";

  const contextLines = [
    "You are evaluating a Slack direct mention notification.",
    "Return JSON only. Do not add markdown fences or extra prose.",
    'Schema: {"action":"no_action|draft_reply|needs_review","reason":"string?","replyText":"string?","reviewNotes":"string?"}',
    "Rules:",
    "- Read Slack context before drafting a reply when an anchor is available.",
    `- If threadTs is present, call tool_hub with {"provider":"slack","action":"search","args":{"mode":"thread","channelId":"${channelId}","threadTs":"${threadTs ?? ""}"${permalinkJson}${workspaceUrlJson}}}.`,
    `- Else if messageTs is present, call tool_hub with {"provider":"slack","action":"search","args":{"mode":"message","channelId":"${channelId}","messageTs":"${messageTs ?? ""}"${permalinkJson}${workspaceUrlJson}}}.`,
    `- Else if permalink is present, call tool_hub with {"provider":"slack","action":"search","args":{"mode":"permalink","permalink":"${permalink ?? ""}"${workspaceUrlJson}}}.`,
    "- If tool_hub slack/search fails, times out, or returns insufficient context, respond with action=needs_review.",
    "- Use draft_reply only when a concrete reply draft can be written from the available context.",
    "- Use needs_review when context is insufficient, anchor resolution failed, or the notification looks ambiguous.",
    "- Use no_action when the notification is informational and no reply is needed.",
    "- replyText is required when action=draft_reply.",
    "",
    "Notification:",
    `channelId: ${channelId}`,
    `title: ${title}`,
    `messageText: ${messageText}`,
    `messageTs: ${messageTs ?? ""}`,
    `threadTs: ${threadTs ?? ""}`,
    `permalink: ${permalink ?? ""}`,
    `workspaceUrl: ${workspaceUrl ?? ""}`,
  ];
  return contextLines.join("\n");
}

function applyToolFailureFallback(
  decision: NotificationDecision,
  toolCalls: Iterable<NotificationDecisionToolCall> | undefined
): NotificationDecision {
  const toolFailure = summarizePlaySlackSearchFailure(toolCalls);
  if (toolFailure === undefined) {
    return decision;
  }

  const reviewNotes = [decision.reviewNotes, toolFailure].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );

  return {
    action: "needs_review",
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(decision.replyText ? { replyText: decision.replyText } : {}),
    reviewNotes: reviewNotes.join("\n"),
  };
}

function summarizePlaySlackSearchFailure(
  toolCalls: Iterable<NotificationDecisionToolCall> | undefined
): string | undefined {
  if (toolCalls === undefined) {
    return undefined;
  }
  for (const toolCall of toolCalls) {
    const isPlaySlackSearch = toolCall.toolName === "play_slack_search";
    const isToolHubSlackSearch =
      toolCall.toolName === "tool_hub" && isToolHubSlackSearchRawInput(toolCall.rawInput);
    if (!isPlaySlackSearch && !isToolHubSlackSearch) {
      continue;
    }
    if (toolCall.status !== "failed" && toolCall.status !== "error") {
      continue;
    }
    const detail = asString(toolCall.result);
    return detail ? `tool_hub slack/search failed: ${detail}` : "tool_hub slack/search failed";
  }
  return undefined;
}
