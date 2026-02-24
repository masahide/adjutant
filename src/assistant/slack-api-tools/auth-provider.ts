import {
  createSlackApiError,
  type SlackApiError,
  type SlackAuthResolved,
  type SlackAuthState,
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

export type SlackAuthProviderOptions = {
  xoxcToken?: string;
  xoxdToken?: string;
  userAgent?: string;
  acceptLanguage?: string;
  cookieName?: string;
  tokenStateProvider?: () => SlackAuthState | null;
};

export class SlackAuthProvider {
  private readonly state: SlackAuthState;
  private readonly userAgent: string;
  private readonly acceptLanguage: string;
  private readonly cookieName: string;
  private readonly tokenStateProvider?: () => SlackAuthState | null;

  constructor(options: SlackAuthProviderOptions = {}) {
    this.state = {
      xoxcToken: normalizeNonEmptyString(options.xoxcToken),
      xoxdToken: normalizeNonEmptyString(options.xoxdToken),
    };
    this.userAgent = normalizeNonEmptyString(options.userAgent) ?? DEFAULT_USER_AGENT;
    this.acceptLanguage = normalizeNonEmptyString(options.acceptLanguage) ?? "en-US,en;q=0.9";
    this.cookieName = normalizeNonEmptyString(options.cookieName) ?? "d";
    this.tokenStateProvider = options.tokenStateProvider;
  }

  private readEffectiveState(): SlackAuthState {
    const cached = this.tokenStateProvider?.() ?? null;
    return {
      xoxcToken: this.state.xoxcToken ?? normalizeNonEmptyString(cached?.xoxcToken),
      xoxdToken: this.state.xoxdToken ?? normalizeNonEmptyString(cached?.xoxdToken),
    };
  }

  validate(): SlackApiError | null {
    const effective = this.readEffectiveState();
    if (!effective.xoxcToken || !effective.xoxdToken) {
      return createSlackApiError({
        code: "auth_invalid",
        message: "xoxc/xoxd token is required",
      });
    }
    return null;
  }

  resolve(): SlackAuthResolved | null {
    const invalid = this.validate();
    if (invalid) {
      return null;
    }
    const effective = this.readEffectiveState();
    const xoxcToken = effective.xoxcToken as string;
    const xoxdToken = effective.xoxdToken as string;
    return {
      xoxcToken,
      xoxdToken,
      defaultHeaders: {
        Authorization: `Bearer ${xoxcToken}`,
        Cookie: `${this.cookieName}=${xoxdToken}`,
        "User-Agent": this.userAgent,
        "Accept-Language": this.acceptLanguage,
      },
    };
  }
}
