import {
  createSlackApiError,
  type SlackApiError,
  type SlackAuthResolved,
  type SlackAuthState,
  type SlackAuthTestResult,
} from "./types.js";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeAuthTest(
  value: SlackAuthTestResult | undefined
): SlackAuthTestResult | undefined {
  if (!value) {
    return undefined;
  }
  const normalized: SlackAuthTestResult = {
    teamId: normalizeNonEmptyString(value.teamId),
    enterpriseId: normalizeNonEmptyString(value.enterpriseId),
    url: normalizeNonEmptyString(value.url),
    userId: normalizeNonEmptyString(value.userId),
  };
  if (!normalized.teamId && !normalized.enterpriseId && !normalized.url && !normalized.userId) {
    return undefined;
  }
  return normalized;
}

export type SlackAuthProviderOptions = {
  xoxcToken?: string;
  xoxdToken?: string;
  workspaceKey?: string;
  userAgent?: string;
  acceptLanguage?: string;
  cookieName?: string;
  tokenStateProvider?: (workspaceKey?: string) => SlackAuthState | null;
};

export class SlackAuthProvider {
  private readonly state: SlackAuthState;
  private readonly userAgent: string;
  private readonly acceptLanguage: string;
  private readonly cookieName: string;
  private readonly tokenStateProvider?: (workspaceKey?: string) => SlackAuthState | null;

  constructor(options: SlackAuthProviderOptions = {}) {
    this.state = {
      xoxcToken: normalizeNonEmptyString(options.xoxcToken),
      xoxdToken: normalizeNonEmptyString(options.xoxdToken),
      workspaceKey: normalizeNonEmptyString(options.workspaceKey),
      authTest: undefined,
    };
    this.userAgent = normalizeNonEmptyString(options.userAgent) ?? DEFAULT_USER_AGENT;
    this.acceptLanguage = normalizeNonEmptyString(options.acceptLanguage) ?? "en-US,en;q=0.9";
    this.cookieName = normalizeNonEmptyString(options.cookieName) ?? "d";
    this.tokenStateProvider = options.tokenStateProvider;
  }

  private readEffectiveState(workspaceKey?: string): SlackAuthState {
    const requestedWorkspace = normalizeNonEmptyString(workspaceKey);
    const cachedByWorkspace = this.tokenStateProvider?.(requestedWorkspace) ?? null;
    const cachedDefault = requestedWorkspace ? (this.tokenStateProvider?.() ?? null) : null;
    return {
      xoxcToken:
        this.state.xoxcToken ??
        normalizeNonEmptyString(cachedByWorkspace?.xoxcToken) ??
        normalizeNonEmptyString(cachedDefault?.xoxcToken),
      xoxdToken:
        this.state.xoxdToken ??
        normalizeNonEmptyString(cachedByWorkspace?.xoxdToken) ??
        normalizeNonEmptyString(cachedDefault?.xoxdToken),
      workspaceKey:
        requestedWorkspace ??
        this.state.workspaceKey ??
        normalizeNonEmptyString(cachedByWorkspace?.workspaceKey) ??
        normalizeNonEmptyString(cachedDefault?.workspaceKey) ??
        "global",
      authTest:
        normalizeAuthTest(this.state.authTest) ??
        normalizeAuthTest(cachedByWorkspace?.authTest) ??
        normalizeAuthTest(cachedDefault?.authTest),
    };
  }

  validate(workspaceKey?: string): SlackApiError | null {
    const effective = this.readEffectiveState(workspaceKey);
    if (!effective.xoxcToken || !effective.xoxdToken) {
      return createSlackApiError({
        code: "auth_invalid",
        message: "xoxc/xoxd token is required",
      });
    }
    return null;
  }

  resolve(workspaceKey?: string): SlackAuthResolved | null {
    const invalid = this.validate(workspaceKey);
    if (invalid) {
      return null;
    }
    const effective = this.readEffectiveState(workspaceKey);
    const xoxcToken = effective.xoxcToken as string;
    const xoxdToken = effective.xoxdToken as string;
    return {
      xoxcToken,
      xoxdToken,
      workspaceKey: effective.workspaceKey ?? "global",
      authTest: normalizeAuthTest(effective.authTest),
      defaultHeaders: {
        Authorization: `Bearer ${xoxcToken}`,
        Cookie: `${this.cookieName}=${xoxdToken}`,
        "User-Agent": this.userAgent,
        "Accept-Language": this.acceptLanguage,
      },
    };
  }
}
