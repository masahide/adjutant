export type SlackAuthTokenKind = "xoxc" | "xoxd";

export type SlackAuthTokenSourceStage =
  | "requestWillBeSent"
  | "requestWillBeSentExtraInfo"
  | "cookieStoreSnapshot";

export type SlackAuthTokenEntry = {
  value: string;
  firstSeenAt: number;
  lastSeenAt: number;
  hits: number;
  sourceStage: SlackAuthTokenSourceStage;
  requestId?: string;
  url?: string;
};

export type SlackAuthTokenPair = {
  xoxc?: SlackAuthTokenEntry;
  xoxd?: SlackAuthTokenEntry;
};

export type SlackAuthTokenObserveInput = {
  tokenKind: SlackAuthTokenKind;
  value: string;
  sourceStage: SlackAuthTokenSourceStage;
  requestId?: string;
  url?: string;
  workspaceKey?: string;
  observedAt?: number;
};

export type SlackAuthTokenObserveResult = {
  workspaceKey: string;
  tokenKind: SlackAuthTokenKind;
  updated: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  hits: number;
  sourceStage: SlackAuthTokenSourceStage;
};

export type SlackAuthTokenCacheSnapshot = {
  workspaceKey: string;
  tokens: SlackAuthTokenPair;
};

const GLOBAL_WORKSPACE_KEY = "global";
const TEAM_ID_RE = /^[A-Z0-9]{8,}$/i;
const GENERIC_SLACK_SUBDOMAINS = new Set(["app", "edgeapi", "hooks"]);

const asNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const pickFirstQueryValue = (value: string | string[] | undefined): string | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = asNonEmptyString(item);
      if (candidate) {
        return candidate;
      }
    }
    return undefined;
  }
  return asNonEmptyString(value);
};

const resolveFromParsedUrl = (parsed: URL): string | undefined => {
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length >= 2 && segments[0] === "cache") {
    const fromPath = asNonEmptyString(segments[1]);
    if (fromPath) {
      return fromPath;
    }
  }

  const route = asNonEmptyString(parsed.searchParams.get("slack_route") ?? undefined);
  if (route) {
    const fromRoute = asNonEmptyString(route.split(":")[0]);
    if (fromRoute) {
      return fromRoute;
    }
  }

  const team = asNonEmptyString(
    pickFirstQueryValue(parsed.searchParams.getAll("team_id")) ??
      pickFirstQueryValue(parsed.searchParams.getAll("team"))
  );
  if (team && TEAM_ID_RE.test(team)) {
    return team;
  }

  const hostParts = parsed.hostname.split(".").filter((part) => part.length > 0);
  if (hostParts.length >= 3 && hostParts.slice(-2).join(".") === "slack.com") {
    const subdomain = asNonEmptyString(hostParts[0]);
    if (subdomain && !GENERIC_SLACK_SUBDOMAINS.has(subdomain.toLowerCase())) {
      return subdomain;
    }
  }

  return undefined;
};

export const resolveSlackWorkspaceKey = (url: string | undefined): string => {
  const normalizedUrl = asNonEmptyString(url);
  if (!normalizedUrl) {
    return GLOBAL_WORKSPACE_KEY;
  }
  try {
    const parsed = new URL(normalizedUrl);
    return resolveFromParsedUrl(parsed) ?? GLOBAL_WORKSPACE_KEY;
  } catch {
    return GLOBAL_WORKSPACE_KEY;
  }
};

const cloneEntry = (entry: SlackAuthTokenEntry | undefined): SlackAuthTokenEntry | undefined => {
  if (!entry) {
    return undefined;
  }
  return {
    value: entry.value,
    firstSeenAt: entry.firstSeenAt,
    lastSeenAt: entry.lastSeenAt,
    hits: entry.hits,
    sourceStage: entry.sourceStage,
    requestId: entry.requestId,
    url: entry.url,
  };
};

export class SlackAuthTokenCache {
  private readonly byWorkspace = new Map<string, SlackAuthTokenPair>();

  observe(input: SlackAuthTokenObserveInput): SlackAuthTokenObserveResult | null {
    const value = asNonEmptyString(input.value);
    if (!value) {
      return null;
    }

    const observedAt = Number.isFinite(input.observedAt) ? Number(input.observedAt) : Date.now();
    const workspaceKey =
      asNonEmptyString(input.workspaceKey) ?? resolveSlackWorkspaceKey(asNonEmptyString(input.url));
    const tokenPair = this.byWorkspace.get(workspaceKey) ?? {};
    const current = tokenPair[input.tokenKind];

    if (current && current.value === value) {
      current.hits += 1;
      current.lastSeenAt = observedAt;
      return {
        workspaceKey,
        tokenKind: input.tokenKind,
        updated: false,
        firstSeenAt: current.firstSeenAt,
        lastSeenAt: current.lastSeenAt,
        hits: current.hits,
        sourceStage: current.sourceStage,
      };
    }

    const nextEntry: SlackAuthTokenEntry = {
      value,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      hits: 1,
      sourceStage: input.sourceStage,
      requestId: asNonEmptyString(input.requestId),
      url: asNonEmptyString(input.url),
    };
    tokenPair[input.tokenKind] = nextEntry;
    this.byWorkspace.set(workspaceKey, tokenPair);

    return {
      workspaceKey,
      tokenKind: input.tokenKind,
      updated: true,
      firstSeenAt: nextEntry.firstSeenAt,
      lastSeenAt: nextEntry.lastSeenAt,
      hits: nextEntry.hits,
      sourceStage: nextEntry.sourceStage,
    };
  }

  snapshot(workspaceKey: string): SlackAuthTokenCacheSnapshot | null {
    const normalizedWorkspace = asNonEmptyString(workspaceKey) ?? GLOBAL_WORKSPACE_KEY;
    const tokenPair = this.byWorkspace.get(normalizedWorkspace);
    if (!tokenPair) {
      return null;
    }
    return {
      workspaceKey: normalizedWorkspace,
      tokens: {
        xoxc: cloneEntry(tokenPair.xoxc),
        xoxd: cloneEntry(tokenPair.xoxd),
      },
    };
  }

  snapshots(): SlackAuthTokenCacheSnapshot[] {
    return [...this.byWorkspace.entries()].map(([workspaceKey, tokens]) => ({
      workspaceKey,
      tokens: {
        xoxc: cloneEntry(tokens.xoxc),
        xoxd: cloneEntry(tokens.xoxd),
      },
    }));
  }
}
