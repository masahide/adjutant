import type { SlackAuthTokenCacheSnapshot } from "./slackAuthTokenCache.js";

type CachedTokenPair = {
  workspaceKey: string;
  xoxcToken?: string;
  xoxdToken?: string;
  lastSeenAt: number;
};

type CachedAccountTokens = Map<string, CachedTokenPair>;

const byAccount = new Map<string, CachedAccountTokens>();

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeAccountId(value: string | undefined): string {
  const normalized = normalizeString(value) ?? "default";
  const sanitized = normalized.replace(/[^A-Za-z0-9._-]+/g, "_");
  return sanitized || "default";
}

function toLastSeenAt(snapshot: SlackAuthTokenCacheSnapshot): number {
  const xoxcLastSeen = snapshot.tokens.xoxc?.lastSeenAt;
  const xoxdLastSeen = snapshot.tokens.xoxd?.lastSeenAt;
  const values = [xoxcLastSeen, xoxdLastSeen].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value)
  );
  if (values.length === 0) {
    return Date.now();
  }
  return Math.max(...values);
}

export function syncSlackAuthTokenSnapshots(params: {
  accountId?: string;
  snapshots: SlackAuthTokenCacheSnapshot[];
}): void {
  const accountId = normalizeAccountId(params.accountId);
  const snapshotList = Array.isArray(params.snapshots) ? params.snapshots : [];
  if (snapshotList.length === 0) {
    return;
  }

  let accountMap = byAccount.get(accountId);
  if (!accountMap) {
    accountMap = new Map<string, CachedTokenPair>();
    byAccount.set(accountId, accountMap);
  }

  for (const snapshot of snapshotList) {
    const workspaceKey = normalizeString(snapshot.workspaceKey);
    if (!workspaceKey) {
      continue;
    }

    const previous = accountMap.get(workspaceKey);
    const xoxcToken = normalizeString(snapshot.tokens.xoxc?.value) ?? previous?.xoxcToken;
    const xoxdToken = normalizeString(snapshot.tokens.xoxd?.value) ?? previous?.xoxdToken;
    const lastSeenAt = Math.max(previous?.lastSeenAt ?? 0, toLastSeenAt(snapshot));

    accountMap.set(workspaceKey, {
      workspaceKey,
      xoxcToken,
      xoxdToken,
      lastSeenAt,
    });
  }
}

export function resolveSlackAuthTokensFromCache(params?: {
  accountId?: string;
  workspaceKey?: string;
}): { xoxcToken: string; xoxdToken: string; workspaceKey: string } | null {
  const accountId = normalizeAccountId(params?.accountId);
  const accountMap = byAccount.get(accountId);
  if (!accountMap || accountMap.size === 0) {
    return null;
  }

  const workspaceKey = normalizeString(params?.workspaceKey);
  if (workspaceKey) {
    const found = accountMap.get(workspaceKey);
    if (found?.xoxcToken && found?.xoxdToken) {
      return {
        xoxcToken: found.xoxcToken,
        xoxdToken: found.xoxdToken,
        workspaceKey,
      };
    }
    return null;
  }

  let candidate: CachedTokenPair | null = null;
  for (const item of accountMap.values()) {
    if (!item.xoxcToken || !item.xoxdToken) {
      continue;
    }
    if (!candidate || item.lastSeenAt > candidate.lastSeenAt) {
      candidate = item;
    }
  }

  if (!candidate) {
    return null;
  }

  return {
    xoxcToken: candidate.xoxcToken as string,
    xoxdToken: candidate.xoxdToken as string,
    workspaceKey: candidate.workspaceKey,
  };
}

export function resetSlackAuthTokenCacheForTest(): void {
  byAccount.clear();
}
