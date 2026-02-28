import { join, resolve } from "node:path";

const DEFAULT_ACCOUNT_ID = "default";

export function normalizeAccountId(
  value: string | undefined,
  fallback = DEFAULT_ACCOUNT_ID
): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return fallback;
  }
  const sanitized = normalized.replace(/[^A-Za-z0-9._-]+/g, "_");
  return sanitized || fallback;
}

export function resolveDefaultDataDir(stateDir: string): string {
  return resolve(join(stateDir, "data"));
}

export function resolveAccountBaseDir(params: {
  dataDir: string;
  accountId?: string;
  fallbackAccountId?: string;
}): string {
  const accountId = normalizeAccountId(
    params.accountId,
    params.fallbackAccountId ?? DEFAULT_ACCOUNT_ID
  );
  return join(resolve(params.dataDir), "accounts", accountId);
}

export function resolveEventJsonlPath(params: {
  dataDir: string;
  accountId?: string;
  fallbackAccountId?: string;
  dateKey: string;
  source: "slack" | "github" | "git-local";
}): { dir: string; file: string } {
  const [year = "1970", month = "01", day = "01"] = params.dateKey.split("-");
  const dir = join(
    resolveAccountBaseDir({
      dataDir: params.dataDir,
      accountId: params.accountId,
      fallbackAccountId: params.fallbackAccountId,
    }),
    year,
    month.padStart(2, "0"),
    day.padStart(2, "0"),
    params.source
  );
  return {
    dir,
    file: join(dir, "events.jsonl"),
  };
}

export function resolveSlackCacheBaseDir(params: {
  dataDir: string;
  accountId?: string;
  fallbackAccountId?: string;
}): string {
  return join(
    resolveAccountBaseDir({
      dataDir: params.dataDir,
      accountId: params.accountId,
      fallbackAccountId: params.fallbackAccountId,
    }),
    "_cache",
    "slack"
  );
}
