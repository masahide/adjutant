import { chmodSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { normalizeAccountId } from "../runtime/data-paths.js";
import type { SlackAuthTokenSourceStage } from "./slackAuthTokenCache.js";

export const SLACK_AUTH_TOKEN_STORE_SCHEMA = "adjutant.slack.auth-token-store.v1";
export const SLACK_AUTH_TOKEN_STORE_FILENAME = "auth-token-store.json";
export const SLACK_PENDING_ACCOUNT_ID = "_pending";

export type SlackAuthTestStatus =
  | "pending"
  | "ok"
  | "invalid_auth"
  | "rate_limited"
  | "network_error"
  | "api_error";

export type PersistedTokenEntry = {
  value: string;
  firstSeenAt: number;
  lastSeenAt: number;
  hits: number;
  sourceStage: SlackAuthTokenSourceStage;
};

export type PersistedAuthTest = {
  status: SlackAuthTestStatus;
  triedAt?: string;
  succeededAt?: string;
  teamId?: string;
  enterpriseId?: string;
  url?: string;
  userId?: string;
  errorCode?: string;
  errorMessage?: string;
};

export type PersistedWorkspaceToken = {
  workspaceKey: string;
  aliases: string[];
  tokens: {
    xoxc?: PersistedTokenEntry;
    xoxd?: PersistedTokenEntry;
  };
  authTest?: PersistedAuthTest;
};

export type PersistedAuthTokenStore = {
  schema: typeof SLACK_AUTH_TOKEN_STORE_SCHEMA;
  updatedAt: string;
  entries: PersistedWorkspaceToken[];
};

export type LoadedAuthTokenStores = {
  pending: PersistedWorkspaceToken[];
  byAccount: Map<string, PersistedWorkspaceToken[]>;
};

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Number(value);
}

function asSourceStage(value: unknown): SlackAuthTokenSourceStage | undefined {
  if (
    value === "requestWillBeSent" ||
    value === "requestWillBeSentExtraInfo" ||
    value === "cookieStoreSnapshot"
  ) {
    return value;
  }
  return undefined;
}

function parseTokenEntry(value: unknown): PersistedTokenEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const tokenValue = asString(record.value);
  const firstSeenAt = asNumber(record.firstSeenAt);
  const lastSeenAt = asNumber(record.lastSeenAt);
  const hits = asNumber(record.hits);
  const sourceStage = asSourceStage(record.sourceStage);
  if (
    !tokenValue ||
    firstSeenAt === undefined ||
    lastSeenAt === undefined ||
    hits === undefined ||
    !sourceStage
  ) {
    return undefined;
  }
  return {
    value: tokenValue,
    firstSeenAt,
    lastSeenAt,
    hits,
    sourceStage,
  };
}

function parseAuthTest(value: unknown): PersistedAuthTest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const status = asString(record.status) as SlackAuthTestStatus | undefined;
  if (
    status !== "pending" &&
    status !== "ok" &&
    status !== "invalid_auth" &&
    status !== "rate_limited" &&
    status !== "network_error" &&
    status !== "api_error"
  ) {
    return undefined;
  }
  return {
    status,
    triedAt: asString(record.triedAt),
    succeededAt: asString(record.succeededAt),
    teamId: asString(record.teamId),
    enterpriseId: asString(record.enterpriseId),
    url: asString(record.url),
    userId: asString(record.userId),
    errorCode: asString(record.errorCode),
    errorMessage: asString(record.errorMessage),
  };
}

function parseWorkspaceEntry(value: unknown): PersistedWorkspaceToken | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const workspaceKey = asString(record.workspaceKey);
  if (!workspaceKey) {
    return null;
  }
  const aliases = Array.isArray(record.aliases)
    ? record.aliases.map((item) => asString(item)).filter((item): item is string => Boolean(item))
    : [];
  const tokenRecord =
    record.tokens && typeof record.tokens === "object" && !Array.isArray(record.tokens)
      ? (record.tokens as Record<string, unknown>)
      : {};
  return {
    workspaceKey,
    aliases: dedupeAliases(workspaceKey, aliases),
    tokens: {
      xoxc: parseTokenEntry(tokenRecord.xoxc),
      xoxd: parseTokenEntry(tokenRecord.xoxd),
    },
    authTest: parseAuthTest(record.authTest),
  };
}

function dedupeAliases(workspaceKey: string, aliases: string[]): string[] {
  const deduped = new Set<string>();
  deduped.add(workspaceKey);
  for (const alias of aliases) {
    const normalized = asString(alias);
    if (!normalized) {
      continue;
    }
    deduped.add(normalized);
  }
  return [...deduped];
}

function parseStoreJson(raw: string): PersistedWorkspaceToken[] {
  const parsed = JSON.parse(raw) as { schema?: unknown; entries?: unknown };
  if (parsed.schema !== SLACK_AUTH_TOKEN_STORE_SCHEMA) {
    return [];
  }
  const entriesRaw = Array.isArray(parsed.entries) ? parsed.entries : [];
  const entries: PersistedWorkspaceToken[] = [];
  for (const item of entriesRaw) {
    const parsedEntry = parseWorkspaceEntry(item);
    if (parsedEntry) {
      entries.push(parsedEntry);
    }
  }
  return entries;
}

function readStoreEntriesSync(filePath: string): PersistedWorkspaceToken[] {
  try {
    const raw = readFileSync(filePath, "utf8");
    return parseStoreJson(raw);
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function resolveSlackAuthPendingStorePath(dataDir: string): string {
  return join(
    resolve(dataDir),
    "accounts",
    SLACK_PENDING_ACCOUNT_ID,
    "_cache",
    "slack",
    SLACK_AUTH_TOKEN_STORE_FILENAME
  );
}

export function resolveSlackAuthAccountStorePath(dataDir: string, accountId: string): string {
  return join(
    resolve(dataDir),
    "accounts",
    normalizeAccountId(accountId, "default"),
    "_cache",
    "slack",
    SLACK_AUTH_TOKEN_STORE_FILENAME
  );
}

export type SlackAuthTokenStoreOptions = {
  dataDir: string;
  now?: () => Date;
};

export class SlackAuthTokenStore {
  private readonly dataDir: string;
  private readonly now: () => Date;

  constructor(options: SlackAuthTokenStoreOptions) {
    this.dataDir = resolve(options.dataDir);
    this.now = options.now ?? (() => new Date());
  }

  loadAllSync(): LoadedAuthTokenStores {
    const pending = readStoreEntriesSync(resolveSlackAuthPendingStorePath(this.dataDir));
    const byAccount = new Map<string, PersistedWorkspaceToken[]>();
    const accountsRoot = join(this.dataDir, "accounts");
    if (!isDirectory(accountsRoot)) {
      return { pending, byAccount };
    }

    let entries: string[] = [];
    try {
      entries = readdirSync(accountsRoot);
    } catch {
      return { pending, byAccount };
    }

    for (const accountIdRaw of entries) {
      const accountId = asString(accountIdRaw);
      if (!accountId || accountId === SLACK_PENDING_ACCOUNT_ID) {
        continue;
      }
      const storePath = resolveSlackAuthAccountStorePath(this.dataDir, accountId);
      const storeEntries = readStoreEntriesSync(storePath);
      if (storeEntries.length === 0) {
        continue;
      }
      byAccount.set(normalizeAccountId(accountId, "default"), storeEntries);
    }

    return { pending, byAccount };
  }

  async writePending(entries: PersistedWorkspaceToken[]): Promise<void> {
    await this.writeToPath(resolveSlackAuthPendingStorePath(this.dataDir), entries);
  }

  async writeAccount(accountId: string, entries: PersistedWorkspaceToken[]): Promise<void> {
    await this.writeToPath(resolveSlackAuthAccountStorePath(this.dataDir, accountId), entries);
  }

  private async writeToPath(filePath: string, entries: PersistedWorkspaceToken[]): Promise<void> {
    const payload: PersistedAuthTokenStore = {
      schema: SLACK_AUTH_TOKEN_STORE_SCHEMA,
      updatedAt: this.now().toISOString(),
      entries,
    };
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // no-op
    }
  }
}
