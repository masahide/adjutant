import type { GetActivityFeedResponse, ActivityItem } from "../contracts/http-api.js";
import type { TimelineRecordV1_5 } from "../proactive/schema.js";
import type { TimelineStore } from "../proactive/timeline-store.js";
import type { SlackNotificationDetail } from "../../core/events.js";

type ActivityFeedInput = {
  limit?: number;
  cursor?: string;
};

type BuilderOptions = {
  nowIso?: () => string;
};

function parseLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 20;
  }
  return Math.min(100, Math.max(1, Math.floor(value as number)));
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(Math.max(0, Math.floor(offset))), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return 0;
    }
    return parsed;
  } catch {
    return 0;
  }
}

function isNotificationRecord(record: TimelineRecordV1_5): boolean {
  return record.recordType === "event" && record.event.kind === "notification";
}

type NotificationDecisionProjection = {
  notificationUid: string;
  kind: "draft_reply" | "needs_review" | "no_action";
  messageText: string;
  summary?: string;
};

function isNotificationDecisionRecord(record: TimelineRecordV1_5): boolean {
  return record.recordType === "event" && record.event.kind === "notification_decision";
}

function getSlackDetail(record: TimelineRecordV1_5): SlackNotificationDetail | undefined {
  if (record.recordType !== "event") {
    return undefined;
  }
  const detail = record.event.detail;
  if (!detail || typeof detail !== "object" || !("slack" in detail)) {
    return undefined;
  }
  return detail.slack as SlackNotificationDetail;
}

function toActivityItem(
  record: Extract<TimelineRecordV1_5, { recordType: "event" }>
): ActivityItem {
  const slack = getSlackDetail(record);
  const messageText = slack?.message_text ?? record.event.subject ?? "";
  return {
    activityId: record.uid,
    ts: record.ts,
    kind: "notification_received",
    messageText,
    title: slack?.title,
    sessionKey: record.sessionKey,
    permalink: slack?.permalink,
  };
}

function toDecisionProjection(
  record: Extract<TimelineRecordV1_5, { recordType: "event" }>
): NotificationDecisionProjection | undefined {
  const meta = record.event.meta;
  if (meta === undefined || typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return undefined;
  }
  const notificationUid =
    typeof meta.notificationUid === "string" && meta.notificationUid.trim().length > 0
      ? meta.notificationUid
      : undefined;
  const action = meta.action;
  if (
    notificationUid === undefined ||
    (action !== "draft_reply" && action !== "needs_review" && action !== "no_action")
  ) {
    return undefined;
  }
  const originalMessageText =
    typeof meta.originalMessageText === "string" ? meta.originalMessageText : "";
  const replyText = typeof meta.replyText === "string" ? meta.replyText : undefined;
  const reason = typeof meta.reason === "string" ? meta.reason : undefined;
  const reviewNotes = typeof meta.reviewNotes === "string" ? meta.reviewNotes : undefined;
  return {
    notificationUid,
    kind: action,
    messageText: action === "draft_reply" ? (replyText ?? "") : originalMessageText,
    summary: action === "needs_review" ? (reviewNotes ?? reason) : reason,
  };
}

export function buildActivityFeedResponse(
  records: TimelineRecordV1_5[],
  input?: ActivityFeedInput,
  options: BuilderOptions = {}
): GetActivityFeedResponse {
  const limit = parseLimit(input?.limit);
  const consumed = decodeCursor(input?.cursor);
  const decisionsByNotificationUid = new Map<string, NotificationDecisionProjection>();
  for (const record of records) {
    if (!isNotificationDecisionRecord(record)) {
      continue;
    }
    const projection = toDecisionProjection(
      record as Extract<TimelineRecordV1_5, { recordType: "event" }>
    );
    if (projection !== undefined) {
      decisionsByNotificationUid.set(projection.notificationUid, projection);
    }
  }
  const notifications = records
    .filter(isNotificationRecord)
    .slice()
    .sort((a, b) => {
      if (a.ts === b.ts) {
        return (b.timelineOffset ?? 0) - (a.timelineOffset ?? 0);
      }
      return a.ts < b.ts ? 1 : -1;
    });
  const start = Math.max(0, consumed);
  const end = Math.min(notifications.length, start + limit);
  const items = notifications.slice(start, end).map((record) => {
    const item = toActivityItem(record as Extract<TimelineRecordV1_5, { recordType: "event" }>);
    const decision = decisionsByNotificationUid.get(record.uid);
    if (decision === undefined) {
      return item;
    }
    return {
      ...item,
      kind: decision.kind,
      messageText: decision.messageText,
      summary: decision.summary,
    };
  });
  const nextConsumed = start + items.length;
  return {
    items,
    nextCursor: nextConsumed < notifications.length ? encodeCursor(nextConsumed) : undefined,
    generatedAt: (options.nowIso ?? (() => new Date().toISOString()))(),
  };
}

export function createActivityFeedReader(
  timelineStore: TimelineStore,
  options: BuilderOptions = {}
): (input?: ActivityFeedInput) => Promise<GetActivityFeedResponse> {
  return async (input?: ActivityFeedInput) => {
    const records = await timelineStore.readRecords();
    return buildActivityFeedResponse(records, input, options);
  };
}
