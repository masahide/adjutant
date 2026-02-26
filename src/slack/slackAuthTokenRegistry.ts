import { resolve } from "node:path";
import { normalizeAccountId } from "../runtime/data-paths.js";
import type { SlackAuthTokenCacheSnapshot, SlackAuthTokenEntry } from "./slackAuthTokenCache.js";
import { resolveSlackWorkspaceKey } from "./slackAuthTokenCache.js";
import { SlackAuthProbeWorker, type SlackAuthProbeResult } from "./slackAuthProbeWorker.js";
import {
  type PersistedAuthTest,
  type PersistedTokenEntry,
  type PersistedWorkspaceToken,
  SlackAuthTokenStore,
} from "./slackAuthTokenStore.js";

type CachedTokenPair = {
  workspaceKey: string;
  aliases: string[];
  tokens: {
    xoxc?: PersistedTokenEntry;
    xoxd?: PersistedTokenEntry;
  };
  authTest?: PersistedAuthTest;
  lastSeenAt: number;
};

type CachedAccountTokens = Map<string, CachedTokenPair>;

type EntryLocation =
  | {
      scope: "pending";
      key: string;
      entry: CachedTokenPair;
    }
  | {
      scope: "account";
      accountId: string;
      key: string;
      entry: CachedTokenPair;
    };

type ResolveCandidate = {
  accountId?: string;
  matchScore: number;
  entry: CachedTokenPair;
};

export type ResolvedSlackAuthTest = {
  teamId?: string;
  enterpriseId?: string;
  url?: string;
  userId?: string;
};

export type SlackAuthWorkspaceSummary = {
  workspaceKey: string;
  aliases: string[];
  accountId?: string;
  hasTokens: boolean;
  authTestStatus?: PersistedAuthTest["status"];
  authTest?: ResolvedSlackAuthTest;
  lastSeenAt: number;
};

export type SlackWorkspacePromotionEvent = {
  workspaceKey: string;
  aliases: string[];
  accountId: string;
  teamId?: string;
  enterpriseId?: string;
};

export type SlackWorkspaceTokenPairReadyEvent = {
  workspaceKey: string;
  aliases: string[];
  accountId?: string;
  xoxcToken: string;
  xoxdToken: string;
};

const byAccount = new Map<string, CachedAccountTokens>();
const pending = new Map<string, CachedTokenPair>();
const backgroundTasks = new Set<Promise<void>>();
const promotionListeners = new Set<(event: SlackWorkspacePromotionEvent) => Promise<void> | void>();
const tokenPairListeners = new Set<
  (event: SlackWorkspaceTokenPairReadyEvent) => Promise<void> | void
>();

let configuredDataDir: string | null = null;
let tokenStore: SlackAuthTokenStore | null = null;
let probeWorker: SlackAuthProbeWorker | null = null;
let warnHandler: ((message: string, meta?: Record<string, unknown>) => void) | undefined;

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractSnapshotTokenRequestId(
  entry: SlackAuthTokenCacheSnapshot["tokens"]["xoxc"] | SlackAuthTokenCacheSnapshot["tokens"]["xoxd"]
): string | undefined {
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  const candidate = (entry as { requestId?: unknown }).requestId;
  return normalizeString(candidate);
}

function isIncoherentSnapshotTokenPair(snapshot: SlackAuthTokenCacheSnapshot): boolean {
  const xoxcValue = normalizeString(snapshot.tokens.xoxc?.value);
  const xoxdValue = normalizeString(snapshot.tokens.xoxd?.value);
  if (!xoxcValue || !xoxdValue) {
    return false;
  }

  const xoxcRequestId = extractSnapshotTokenRequestId(snapshot.tokens.xoxc);
  const xoxdRequestId = extractSnapshotTokenRequestId(snapshot.tokens.xoxd);
  if (!xoxcRequestId || !xoxdRequestId) {
    return false;
  }
  return xoxcRequestId !== xoxdRequestId;
}

function toTokenEntry(input: SlackAuthTokenEntry | undefined): PersistedTokenEntry | undefined {
  if (!input) {
    return undefined;
  }
  const value = normalizeString(input.value);
  if (!value) {
    return undefined;
  }
  const firstSeenAt = Number.isFinite(input.firstSeenAt) ? Number(input.firstSeenAt) : Date.now();
  const lastSeenAt = Number.isFinite(input.lastSeenAt) ? Number(input.lastSeenAt) : firstSeenAt;
  const hits = Number.isFinite(input.hits) ? Math.max(1, Math.floor(Number(input.hits))) : 1;
  return {
    value,
    firstSeenAt,
    lastSeenAt,
    hits,
    sourceStage: input.sourceStage,
  };
}

function tokenPairKey(entry: CachedTokenPair): string | null {
  const xoxc = normalizeString(entry.tokens.xoxc?.value);
  const xoxd = normalizeString(entry.tokens.xoxd?.value);
  if (!xoxc || !xoxd) {
    return null;
  }
  return `${xoxc}\n${xoxd}`;
}

function hasTokenPair(entry: CachedTokenPair): boolean {
  return Boolean(
    normalizeString(entry.tokens.xoxc?.value) && normalizeString(entry.tokens.xoxd?.value)
  );
}

function toLastSeenAt(entry: CachedTokenPair): number {
  const xoxcLastSeen = entry.tokens.xoxc?.lastSeenAt;
  const xoxdLastSeen = entry.tokens.xoxd?.lastSeenAt;
  const values = [xoxcLastSeen, xoxdLastSeen].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value)
  );
  if (values.length === 0) {
    return entry.lastSeenAt;
  }
  return Math.max(...values, entry.lastSeenAt);
}

function dedupeAliases(workspaceKey: string, aliases: string[]): string[] {
  const deduped = new Set<string>();
  const normalizedWorkspace = normalizeString(workspaceKey) ?? "global";
  deduped.add(normalizedWorkspace);
  for (const alias of aliases) {
    const normalized = normalizeString(alias);
    if (!normalized) {
      continue;
    }
    deduped.add(normalized);
  }
  return [...deduped];
}

function extractAliasFromUrl(url: string | undefined): string | undefined {
  const normalized = normalizeString(url);
  if (!normalized) {
    return undefined;
  }
  const alias = resolveSlackWorkspaceKey(normalized);
  return alias === "global" ? undefined : alias;
}

function toEntryFromPersisted(input: PersistedWorkspaceToken): CachedTokenPair {
  const aliases = dedupeAliases(input.workspaceKey, input.aliases ?? []);
  const entry: CachedTokenPair = {
    workspaceKey: aliases[0] ?? "global",
    aliases,
    tokens: {
      xoxc: input.tokens?.xoxc,
      xoxd: input.tokens?.xoxd,
    },
    authTest: input.authTest,
    lastSeenAt: 0,
  };
  entry.lastSeenAt = toLastSeenAt(entry);
  return entry;
}

function toPersisted(entry: CachedTokenPair): PersistedWorkspaceToken {
  return {
    workspaceKey: entry.workspaceKey,
    aliases: dedupeAliases(entry.workspaceKey, entry.aliases),
    tokens: {
      xoxc: entry.tokens.xoxc,
      xoxd: entry.tokens.xoxd,
    },
    authTest: entry.authTest,
  };
}

function updateToken(
  current: PersistedTokenEntry | undefined,
  next: PersistedTokenEntry | undefined
): { token: PersistedTokenEntry | undefined; changed: boolean } {
  if (!next) {
    return { token: current, changed: false };
  }
  if (!current) {
    return { token: next, changed: true };
  }
  if (current.value !== next.value) {
    return { token: next, changed: true };
  }

  const merged: PersistedTokenEntry = {
    ...current,
    firstSeenAt: Math.min(current.firstSeenAt, next.firstSeenAt),
    lastSeenAt: Math.max(current.lastSeenAt, next.lastSeenAt),
    hits: Math.max(current.hits, next.hits),
    sourceStage: next.sourceStage,
  };
  const changed =
    merged.firstSeenAt !== current.firstSeenAt ||
    merged.lastSeenAt !== current.lastSeenAt ||
    merged.hits !== current.hits ||
    merged.sourceStage !== current.sourceStage;
  return { token: merged, changed };
}

function mergeEntries(base: CachedTokenPair, incoming: CachedTokenPair): CachedTokenPair {
  const mergedXoxc = updateToken(base.tokens.xoxc, incoming.tokens.xoxc).token;
  const mergedXoxd = updateToken(base.tokens.xoxd, incoming.tokens.xoxd).token;
  const mergedAuth = incoming.authTest ?? base.authTest;
  const workspaceKey =
    normalizeString(base.workspaceKey) ?? normalizeString(incoming.workspaceKey) ?? "global";
  const aliases = dedupeAliases(workspaceKey, [...base.aliases, ...incoming.aliases]);
  const merged: CachedTokenPair = {
    workspaceKey,
    aliases,
    tokens: { xoxc: mergedXoxc, xoxd: mergedXoxd },
    authTest: mergedAuth,
    lastSeenAt: Math.max(
      base.lastSeenAt,
      incoming.lastSeenAt,
      toLastSeenAt(base),
      toLastSeenAt(incoming)
    ),
  };
  merged.lastSeenAt = toLastSeenAt(merged);
  return merged;
}

function locateInMap(
  map: CachedAccountTokens,
  workspaceKey: string
): { key: string; entry: CachedTokenPair } | null {
  const exact = map.get(workspaceKey);
  if (exact) {
    return { key: workspaceKey, entry: exact };
  }
  for (const [key, entry] of map.entries()) {
    if (entry.aliases.includes(workspaceKey)) {
      return { key, entry };
    }
  }
  return null;
}

function findEntry(workspaceKey: string): EntryLocation | null {
  const pendingHit = locateInMap(pending, workspaceKey);
  if (pendingHit) {
    return {
      scope: "pending",
      key: pendingHit.key,
      entry: pendingHit.entry,
    };
  }

  for (const [accountId, accountMap] of byAccount.entries()) {
    const hit = locateInMap(accountMap, workspaceKey);
    if (hit) {
      return {
        scope: "account",
        accountId,
        key: hit.key,
        entry: hit.entry,
      };
    }
  }
  return null;
}

function normalizeWorkspaceKey(value: string | undefined): string {
  return normalizeString(value) ?? "global";
}

function appendAuthAliases(entry: CachedTokenPair, authTest: PersistedAuthTest): void {
  const aliases = [...entry.aliases];
  const teamId = normalizeString(authTest.teamId);
  const enterpriseId = normalizeString(authTest.enterpriseId);
  const urlAlias = extractAliasFromUrl(authTest.url);
  if (teamId) {
    aliases.push(teamId);
  }
  if (enterpriseId) {
    aliases.push(enterpriseId);
  }
  if (urlAlias) {
    aliases.push(urlAlias);
  }
  entry.aliases = dedupeAliases(entry.workspaceKey, aliases);
}

function resolveAccountIdFromAuthTest(authTest: PersistedAuthTest): string | null {
  const enterpriseId = normalizeString(authTest.enterpriseId);
  if (enterpriseId) {
    return normalizeAccountId(enterpriseId, "default");
  }
  const teamId = normalizeString(authTest.teamId);
  if (teamId) {
    return normalizeAccountId(teamId, "default");
  }
  return null;
}

function toWorkspacePromotionEvent(
  entry: CachedTokenPair,
  authTest: PersistedAuthTest,
  accountId: string
): SlackWorkspacePromotionEvent {
  return {
    workspaceKey: entry.workspaceKey,
    aliases: dedupeAliases(entry.workspaceKey, entry.aliases),
    accountId,
    teamId: normalizeString(authTest.teamId),
    enterpriseId: normalizeString(authTest.enterpriseId),
  };
}

function toResolvedAuthTest(authTest: PersistedAuthTest | undefined): ResolvedSlackAuthTest | null {
  if (!authTest || authTest.status !== "ok") {
    return null;
  }
  const teamId = normalizeString(authTest.teamId);
  const enterpriseId = normalizeString(authTest.enterpriseId);
  const url = normalizeString(authTest.url);
  const userId = normalizeString(authTest.userId);
  if (!teamId && !enterpriseId && !url && !userId) {
    return null;
  }
  return { teamId, enterpriseId, url, userId };
}

function toWorkspaceSummary(entry: CachedTokenPair, accountId?: string): SlackAuthWorkspaceSummary {
  return {
    workspaceKey: entry.workspaceKey,
    aliases: dedupeAliases(entry.workspaceKey, entry.aliases),
    accountId,
    hasTokens: hasTokenPair(entry),
    authTestStatus: entry.authTest?.status,
    authTest: toResolvedAuthTest(entry.authTest) ?? undefined,
    lastSeenAt: toLastSeenAt(entry),
  };
}

function emitAuthTestResultLog(meta: {
  workspaceKey: string;
  status: PersistedAuthTest["status"];
  teamId?: string;
  enterpriseId?: string;
  url?: string;
  userId?: string;
  errorCode?: string;
  errorMessage?: string;
}): void {
  try {
    console.info("[SlackAuthTest]", JSON.stringify(meta));
  } catch {
    // no-op
  }
  warnHandler?.("slack-auth-test-result", meta);
}

function trackBackgroundTask(task: Promise<void>): void {
  const wrapped = task.catch((error) => {
    warnHandler?.("slack-auth-token-registry-background-task-failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
  });
  backgroundTasks.add(wrapped);
  void wrapped.finally(() => {
    backgroundTasks.delete(wrapped);
  });
}

function notifyWorkspacePromoted(event: SlackWorkspacePromotionEvent): void {
  if (promotionListeners.size === 0) {
    return;
  }
  for (const listener of promotionListeners) {
    trackBackgroundTask(Promise.resolve(listener(event)).then(() => undefined));
  }
}

function notifyTokenPairReady(entry: CachedTokenPair, accountId?: string): void {
  if (tokenPairListeners.size === 0) {
    return;
  }
  const xoxcToken = normalizeString(entry.tokens.xoxc?.value);
  const xoxdToken = normalizeString(entry.tokens.xoxd?.value);
  if (!xoxcToken || !xoxdToken) {
    return;
  }
  const event: SlackWorkspaceTokenPairReadyEvent = {
    workspaceKey: entry.workspaceKey,
    aliases: dedupeAliases(entry.workspaceKey, entry.aliases),
    accountId,
    xoxcToken,
    xoxdToken,
  };
  for (const listener of tokenPairListeners) {
    trackBackgroundTask(Promise.resolve(listener(event)).then(() => undefined));
  }
}

function persistPending(): void {
  if (!tokenStore) {
    return;
  }
  const entries = [...pending.values()].map((entry) => toPersisted(entry));
  trackBackgroundTask(tokenStore.writePending(entries));
}

function persistAccount(accountId: string): void {
  if (!tokenStore) {
    return;
  }
  const accountMap = byAccount.get(accountId);
  if (!accountMap) {
    return;
  }
  const entries = [...accountMap.values()].map((entry) => toPersisted(entry));
  trackBackgroundTask(tokenStore.writeAccount(accountId, entries));
}

function enqueueProbe(entry: CachedTokenPair): void {
  if (!probeWorker) {
    return;
  }
  if (!hasTokenPair(entry)) {
    return;
  }
  if (entry.authTest?.status === "ok") {
    return;
  }
  const xoxcToken = normalizeString(entry.tokens.xoxc?.value);
  const xoxdToken = normalizeString(entry.tokens.xoxd?.value);
  if (!xoxcToken || !xoxdToken) {
    return;
  }
  probeWorker.enqueue({
    workspaceKey: entry.workspaceKey,
    xoxcToken,
    xoxdToken,
  });
}

function hydrateFromStore(): void {
  if (!tokenStore) {
    return;
  }
  byAccount.clear();
  pending.clear();

  const loaded = tokenStore.loadAllSync();
  for (const pendingEntry of loaded.pending) {
    const next = toEntryFromPersisted(pendingEntry);
    pending.set(next.workspaceKey, next);
  }
  for (const [accountId, entries] of loaded.byAccount.entries()) {
    const normalizedAccountId = normalizeAccountId(accountId, "default");
    const accountMap = byAccount.get(normalizedAccountId) ?? new Map<string, CachedTokenPair>();
    byAccount.set(normalizedAccountId, accountMap);
    for (const persisted of entries) {
      const next = toEntryFromPersisted(persisted);
      const existing = locateInMap(accountMap, next.workspaceKey);
      if (existing) {
        accountMap.set(existing.key, mergeEntries(existing.entry, next));
      } else {
        accountMap.set(next.workspaceKey, next);
      }
    }
  }

  for (const [accountId, accountMap] of byAccount.entries()) {
    for (const entry of accountMap.values()) {
      notifyTokenPairReady(entry, accountId);
      if (entry.authTest?.status !== "ok") {
        continue;
      }
      notifyWorkspacePromoted(toWorkspacePromotionEvent(entry, entry.authTest, accountId));
    }
  }

  for (const entry of pending.values()) {
    notifyTokenPairReady(entry);
    enqueueProbe(entry);
  }
}

async function handleProbeResult(input: {
  workspaceKey: string;
  tokenKey: string;
  result: SlackAuthProbeResult;
}): Promise<void> {
  const location = findEntry(input.workspaceKey);
  if (!location) {
    return;
  }

  const currentTokenKey = tokenPairKey(location.entry);
  if (!currentTokenKey || currentTokenKey !== input.tokenKey) {
    return;
  }

  const result = input.result;
  const nextAuth: PersistedAuthTest = {
    status: result.status,
    triedAt: result.triedAt,
    succeededAt: result.succeededAt,
    teamId: result.teamId,
    enterpriseId: result.enterpriseId,
    url: result.url,
    userId: result.userId,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
  };
  location.entry.authTest = nextAuth;
  appendAuthAliases(location.entry, nextAuth);
  emitAuthTestResultLog({
    workspaceKey: location.entry.workspaceKey,
    status: nextAuth.status,
    teamId: nextAuth.teamId,
    enterpriseId: nextAuth.enterpriseId,
    url: nextAuth.url,
    userId: nextAuth.userId,
    errorCode: nextAuth.errorCode,
    errorMessage: nextAuth.errorMessage,
  });

  if (result.status === "ok") {
    const resolvedAccountId = resolveAccountIdFromAuthTest(nextAuth);
    if (!resolvedAccountId) {
      location.entry.authTest = {
        ...nextAuth,
        status: "api_error",
        errorCode: "missing_account_id",
        errorMessage: "auth.test response does not contain enterprise_id or team_id",
      };
      if (location.scope === "pending") {
        persistPending();
      } else {
        persistAccount(location.accountId);
      }
      return;
    }

    const targetMap = byAccount.get(resolvedAccountId) ?? new Map<string, CachedTokenPair>();
    byAccount.set(resolvedAccountId, targetMap);
    const existing = locateInMap(targetMap, location.entry.workspaceKey);
    if (existing) {
      targetMap.set(existing.key, mergeEntries(existing.entry, location.entry));
    } else {
      targetMap.set(location.entry.workspaceKey, location.entry);
    }
    persistAccount(resolvedAccountId);

    if (location.scope === "pending") {
      pending.delete(location.key);
      persistPending();
    } else if (location.accountId !== resolvedAccountId) {
      const sourceMap = byAccount.get(location.accountId);
      sourceMap?.delete(location.key);
      persistAccount(location.accountId);
    }
    notifyTokenPairReady(location.entry, resolvedAccountId);
    notifyWorkspacePromoted(toWorkspacePromotionEvent(location.entry, nextAuth, resolvedAccountId));
    return;
  }

  if (location.scope === "pending") {
    persistPending();
  } else {
    persistAccount(location.accountId);
  }
}

function findCandidateFromMap(
  map: CachedAccountTokens,
  workspaceKey: string | undefined,
  accountId?: string
): ResolveCandidate | null {
  if (workspaceKey) {
    const exact = map.get(workspaceKey);
    if (exact && hasTokenPair(exact)) {
      return { entry: exact, matchScore: 2, accountId };
    }
  }

  let candidate: ResolveCandidate | null = null;
  for (const entry of map.values()) {
    if (!hasTokenPair(entry)) {
      continue;
    }

    const score = workspaceKey ? (entry.aliases.includes(workspaceKey) ? 1 : 0) : 1;
    if (workspaceKey && score === 0) {
      continue;
    }

    if (!candidate) {
      candidate = { entry, matchScore: score, accountId };
      continue;
    }
    if (score > candidate.matchScore) {
      candidate = { entry, matchScore: score, accountId };
      continue;
    }
    if (score === candidate.matchScore && entry.lastSeenAt > candidate.entry.lastSeenAt) {
      candidate = { entry, matchScore: score, accountId };
    }
  }
  return candidate;
}

function pickCandidate(
  best: ResolveCandidate | null,
  next: ResolveCandidate | null
): ResolveCandidate | null {
  if (!next) {
    return best;
  }
  if (!best) {
    return next;
  }
  if (next.matchScore > best.matchScore) {
    return next;
  }
  if (next.matchScore < best.matchScore) {
    return best;
  }
  return next.entry.lastSeenAt > best.entry.lastSeenAt ? next : best;
}

export type ConfigureSlackAuthTokenRegistryOptions = {
  dataDir: string;
  fetchFn?: typeof fetch;
  authTestEnabled?: boolean;
  authTestTimeoutMs?: number;
  authTestRetryDelaysMs?: number[];
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
  onWorkspacePromoted?: (event: SlackWorkspacePromotionEvent) => Promise<void> | void;
  onTokenPairReady?: (event: SlackWorkspaceTokenPairReadyEvent) => Promise<void> | void;
};

export function configureSlackAuthTokenRegistry(
  options: ConfigureSlackAuthTokenRegistryOptions
): void {
  const dataDir = normalizeString(options.dataDir);
  if (!dataDir) {
    return;
  }
  const authTestEnabled = options.authTestEnabled === true;
  if (options.onWarn) {
    warnHandler = options.onWarn;
  }
  if (options.onWorkspacePromoted) {
    promotionListeners.add(options.onWorkspacePromoted);
  }
  if (options.onTokenPairReady) {
    tokenPairListeners.add(options.onTokenPairReady);
  }

  const resolvedDataDir = resolve(dataDir);
  if (configuredDataDir !== resolvedDataDir) {
    configuredDataDir = resolvedDataDir;
    tokenStore = new SlackAuthTokenStore({ dataDir: resolvedDataDir });
    hydrateFromStore();
  }

  if (probeWorker) {
    probeWorker.resetForTest();
  }
  probeWorker = authTestEnabled
    ? new SlackAuthProbeWorker({
        fetchFn: options.fetchFn,
        timeoutMs: options.authTestTimeoutMs,
        retryDelaysMs: options.authTestRetryDelaysMs,
        onWarn: options.onWarn,
        onResult: handleProbeResult,
      })
    : null;

  for (const entry of pending.values()) {
    enqueueProbe(entry);
  }
}

export function syncSlackAuthTokenSnapshots(params: {
  accountId?: string;
  snapshots: SlackAuthTokenCacheSnapshot[];
}): void {
  void params.accountId;
  const snapshotList = Array.isArray(params.snapshots) ? params.snapshots : [];
  if (snapshotList.length === 0) {
    return;
  }

  const dirtyAccounts = new Set<string>();
  let pendingDirty = false;

  for (const snapshot of snapshotList) {
    if (isIncoherentSnapshotTokenPair(snapshot)) {
      warnHandler?.("slack-auth-token-snapshot-skipped", {
        reason: "incoherent_token_pair",
        workspaceKey: normalizeWorkspaceKey(normalizeString(snapshot.workspaceKey)),
        xoxcRequestId: extractSnapshotTokenRequestId(snapshot.tokens.xoxc) ?? null,
        xoxdRequestId: extractSnapshotTokenRequestId(snapshot.tokens.xoxd) ?? null,
      });
      continue;
    }

    const workspaceKey = normalizeWorkspaceKey(normalizeString(snapshot.workspaceKey));
    const location = findEntry(workspaceKey);
    const xoxc = toTokenEntry(snapshot.tokens.xoxc);
    const xoxd = toTokenEntry(snapshot.tokens.xoxd);

    if (!location) {
      const created: CachedTokenPair = {
        workspaceKey,
        aliases: dedupeAliases(workspaceKey, []),
        tokens: {
          xoxc,
          xoxd,
        },
        authTest: undefined,
        lastSeenAt: Date.now(),
      };
      created.lastSeenAt = toLastSeenAt(created);
      pending.set(workspaceKey, created);
      pendingDirty = true;
      if (hasTokenPair(created)) {
        notifyTokenPairReady(created);
      }
      enqueueProbe(created);
      continue;
    }

    const originalPair = tokenPairKey(location.entry);
    const mergedXoxc = updateToken(location.entry.tokens.xoxc, xoxc);
    const mergedXoxd = updateToken(location.entry.tokens.xoxd, xoxd);
    location.entry.tokens.xoxc = mergedXoxc.token;
    location.entry.tokens.xoxd = mergedXoxd.token;
    location.entry.aliases = dedupeAliases(location.entry.workspaceKey, [
      ...location.entry.aliases,
      workspaceKey,
    ]);
    location.entry.lastSeenAt = toLastSeenAt(location.entry);
    const nextPair = tokenPairKey(location.entry);
    const pairChanged = originalPair !== nextPair;

    if (pairChanged) {
      location.entry.authTest = {
        status: "pending",
      };
    }

    if (location.scope === "pending") {
      pendingDirty = true;
      if (pairChanged) {
        notifyTokenPairReady(location.entry);
      }
    } else {
      dirtyAccounts.add(location.accountId);
      if (pairChanged) {
        notifyTokenPairReady(location.entry, location.accountId);
      }
    }
    enqueueProbe(location.entry);
  }

  if (pendingDirty) {
    persistPending();
  }
  for (const accountId of dirtyAccounts) {
    persistAccount(accountId);
  }
}

export function resolveSlackAuthTokensFromCache(params?: {
  accountId?: string;
  workspaceKey?: string;
}): {
  xoxcToken: string;
  xoxdToken: string;
  workspaceKey: string;
  accountId?: string;
  authTest?: {
    teamId?: string;
    enterpriseId?: string;
    url?: string;
    userId?: string;
  };
} | null {
  const workspaceKey = normalizeString(params?.workspaceKey);
  const normalizedAccountId = normalizeString(params?.accountId)
    ? normalizeAccountId(params?.accountId, "default")
    : undefined;

  let candidate: ResolveCandidate | null = null;
  if (normalizedAccountId) {
    const accountMap = byAccount.get(normalizedAccountId);
    if (accountMap) {
      candidate = pickCandidate(
        candidate,
        findCandidateFromMap(accountMap, workspaceKey, normalizedAccountId)
      );
    }
    if (!candidate && workspaceKey) {
      candidate = pickCandidate(candidate, findCandidateFromMap(pending, workspaceKey));
    }
  } else {
    for (const [accountId, accountMap] of byAccount.entries()) {
      candidate = pickCandidate(
        candidate,
        findCandidateFromMap(accountMap, workspaceKey, accountId)
      );
    }
    candidate = pickCandidate(candidate, findCandidateFromMap(pending, workspaceKey));
  }

  if (!candidate) {
    return null;
  }
  const xoxcToken = normalizeString(candidate.entry.tokens.xoxc?.value);
  const xoxdToken = normalizeString(candidate.entry.tokens.xoxd?.value);
  if (!xoxcToken || !xoxdToken) {
    return null;
  }
  const authTest = toResolvedAuthTest(candidate.entry.authTest);

  return {
    xoxcToken,
    xoxdToken,
    workspaceKey: candidate.entry.workspaceKey,
    accountId: candidate.accountId,
    authTest: authTest ?? undefined,
  };
}

export function listSlackAuthWorkspacesFromCache(params?: {
  accountId?: string;
  includePending?: boolean;
}): SlackAuthWorkspaceSummary[] {
  const normalizedAccountId = normalizeString(params?.accountId)
    ? normalizeAccountId(params?.accountId, "default")
    : undefined;
  const includePending = params?.includePending !== false;

  const entries: SlackAuthWorkspaceSummary[] = [];
  const collect = (map: CachedAccountTokens, accountId?: string) => {
    for (const entry of map.values()) {
      entries.push(toWorkspaceSummary(entry, accountId));
    }
  };

  if (normalizedAccountId) {
    const accountMap = byAccount.get(normalizedAccountId);
    if (accountMap) {
      collect(accountMap, normalizedAccountId);
    }
  } else {
    for (const [accountId, accountMap] of byAccount.entries()) {
      collect(accountMap, accountId);
    }
  }

  if (includePending) {
    collect(pending);
  }

  return entries.sort((left, right) => {
    if (right.lastSeenAt !== left.lastSeenAt) {
      return right.lastSeenAt - left.lastSeenAt;
    }
    if (left.workspaceKey !== right.workspaceKey) {
      return left.workspaceKey.localeCompare(right.workspaceKey);
    }
    return (left.accountId ?? "").localeCompare(right.accountId ?? "");
  });
}

export async function flushSlackAuthTokenRegistryForTest(): Promise<void> {
  if (backgroundTasks.size > 0) {
    await Promise.all([...backgroundTasks]);
  }
  if (probeWorker) {
    await probeWorker.flush();
  }
}

export function resetSlackAuthTokenCacheForTest(): void {
  byAccount.clear();
  pending.clear();
  promotionListeners.clear();
  tokenPairListeners.clear();
  configuredDataDir = null;
  tokenStore = null;
  probeWorker?.resetForTest();
  probeWorker = null;
  backgroundTasks.clear();
  warnHandler = undefined;
}

export function getSlackAuthTokenRegistrySnapshotForTest(): {
  pending: PersistedWorkspaceToken[];
  byAccount: Record<string, PersistedWorkspaceToken[]>;
} {
  const byAccountObject: Record<string, PersistedWorkspaceToken[]> = {};
  for (const [accountId, entries] of byAccount.entries()) {
    byAccountObject[accountId] = [...entries.values()].map((entry) => toPersisted(entry));
  }
  return {
    pending: [...pending.values()].map((entry) => toPersisted(entry)),
    byAccount: byAccountObject,
  };
}
