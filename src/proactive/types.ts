export const TIMELINE_RECORD_SCHEMA_V1_5 = "adjutant.timeline.record.v1.5";
export const WATERMARKS_SCHEMA_V1 = "adjutant.watermarks.v1";
export const POLICY_ROUTING_SCHEMA_V1 = "adjutant.policy.routing.v1";

export type TimelineActionType = "assistant_final" | "assistant_aborted" | "assistant_error";
export type TimelineRecordType = "event" | "action";
export type TimelineRole = "user" | "assistant" | "tool";

export type TimelineRecordV1_5 = {
  schema: typeof TIMELINE_RECORD_SCHEMA_V1_5;
  recordType: TimelineRecordType;
  role: TimelineRole;
  sessionKey: string;
  ts: string;
  loggedAt: string;
  kind?: string;
  uid?: string;
  actor?: string;
  actionType?: TimelineActionType;
  runId?: string;
  [key: string]: unknown;
};

export type WatermarksV1 = {
  schema: typeof WATERMARKS_SCHEMA_V1;
  updatedAt: string;
  scan: {
    timelinePath: string;
    lastScannedOffset: number;
    lastGoodOffset: number;
  };
  sessions: Record<
    string,
    {
      handled: {
        lastHandledOffset?: number;
        lastHandledTs?: string;
      };
      open: {
        oldestOpenPostTs?: string;
        openPostCount?: number;
      };
    }
  >;
};

export type RoutingPolicyPriority = "high" | "normal" | "low";

export type PolicyRoutingChannelRule = {
  priority?: RoutingPolicyPriority;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  notifyBudgetPerHour?: number;
  cooldownMs?: number;
};

export type PolicyRoutingV1 = {
  schema: typeof POLICY_ROUTING_SCHEMA_V1;
  channels?: Record<string, PolicyRoutingChannelRule>;
  defaults?: {
    notifyBudgetPerHour?: number;
    cooldownMs?: number;
  };
};

export type RouteDecision = {
  action: "respond" | "note" | "ignore";
  confidence: number;
  reason: string;
};
