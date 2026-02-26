export type SlackMode = "team" | "enterprise";

export type SlackRoutingMode = "manual_team" | "manual_enterprise" | "auto_probe";

export type WorkspaceRoutePin = {
  workspaceKey: string;
  mode: SlackMode;
  decidedAt: number;
};

export type FallbackResult<T> = {
  modeUsed: SlackMode;
  fallbackTried: boolean;
  data: T;
};

export type SlackApiErrorCode =
  | "auth_invalid"
  | "primary_failed"
  | "fallback_failed"
  | "rate_limited"
  | "not_found"
  | "validation_error"
  | "integration_unavailable"
  | "timeout"
  | "api_error";

export type SlackApiError = {
  ok: false;
  code: SlackApiErrorCode;
  message: string;
  primaryError?: string;
  fallbackError?: string;
};

export type SlackApiSuccess<T> = {
  ok: true;
  data: T;
  modeUsed?: SlackMode;
  fallbackTried?: boolean;
};

export type SlackApiResult<T> = SlackApiSuccess<T> | SlackApiError;

export type SlackAuthState = {
  xoxcToken?: string;
  xoxdToken?: string;
  workspaceKey?: string;
  authTest?: SlackAuthTestResult;
};

export type SlackAuthResolved = {
  xoxcToken: string;
  xoxdToken: string;
  workspaceKey: string;
  authTest?: SlackAuthTestResult;
  defaultHeaders: Record<string, string>;
};

export type SlackAuthTestResult = {
  teamId?: string;
  enterpriseId?: string;
  url?: string;
  userId?: string;
};

export type SlackUser = {
  id: string;
  name: string;
  realName?: string;
  teamId: string;
  profile?: {
    displayName?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    imageOriginal?: string;
  };
};

export type SlackChannel = {
  id: string;
  name: string;
  teamId: string;
  isPrivate?: boolean;
  isIm?: boolean;
  isMpIm?: boolean;
};

export type SlackSearchMessage = {
  channelId: string;
  ts: string;
  userId?: string;
  text?: string;
};

export type SlackPostMessageResult = {
  channelId: string;
  ts: string;
  text?: string;
};

export type SlackRouteStore = {
  get: (workspaceKey: string) => Promise<WorkspaceRoutePin | null>;
  set: (pin: WorkspaceRoutePin) => Promise<void>;
};

export const SLACK_ROUTING_MODES: SlackRoutingMode[] = [
  "manual_team",
  "manual_enterprise",
  "auto_probe",
];

export function isSlackRoutingMode(value: unknown): value is SlackRoutingMode {
  return typeof value === "string" && (SLACK_ROUTING_MODES as string[]).includes(value);
}

export function normalizeSlackRoutingMode(
  value: unknown,
  fallback: SlackRoutingMode = "auto_probe"
): SlackRoutingMode {
  return isSlackRoutingMode(value) ? value : fallback;
}

export function createSlackApiError(input: {
  code: SlackApiErrorCode;
  message: string;
  primaryError?: string;
  fallbackError?: string;
}): SlackApiError {
  return {
    ok: false,
    code: input.code,
    message: input.message,
    primaryError: input.primaryError,
    fallbackError: input.fallbackError,
  };
}

export function createSlackApiSuccess<T>(input: {
  data: T;
  modeUsed?: SlackMode;
  fallbackTried?: boolean;
}): SlackApiSuccess<T> {
  return {
    ok: true,
    data: input.data,
    modeUsed: input.modeUsed,
    fallbackTried: input.fallbackTried,
  };
}
