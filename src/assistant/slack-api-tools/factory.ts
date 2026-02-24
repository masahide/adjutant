import { join, resolve } from "node:path";
import { parseBooleanEnv } from "../../runtime/env-parsers.js";
import {
  normalizeAccountId,
  resolveDefaultDataDir,
  resolveSlackCacheBaseDir,
} from "../../runtime/data-paths.js";
import { resolveAdjutantStateDir } from "../session-paths.js";
import { SlackNameCacheRepository } from "../../slack/nameCacheRepository.js";
import { resolveSlackAuthTokensFromCache } from "../../slack/slackAuthTokenRegistry.js";
import { SlackAuthProvider } from "./auth-provider.js";
import { SlackRouteClient } from "./route-client.js";
import { WorkspaceRoutePinStore } from "./workspace-route-pin-store.js";
import { SlackFallbackExecutor } from "./fallback-executor.js";
import { createSlackDynamicProvider } from "./provider.js";
import { normalizeSlackRoutingMode } from "./types.js";
import { SlackApiService } from "./service.js";

function readString(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

export function isSlackApiToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanEnv(env.ADJUTANT_SLACK_API_ENABLED, true);
}

export type CreateSlackDynamicProviderFromEnvOptions = {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  dataDir?: string;
  now?: () => Date;
};

export function createSlackDynamicProviderFromEnv(
  options: CreateSlackDynamicProviderFromEnvOptions = {}
) {
  const env = options.env ?? process.env;
  const dataDir =
    options.dataDir?.trim() ??
    (env.DATA_DIR?.trim()
      ? resolve(env.DATA_DIR)
      : resolveDefaultDataDir(resolveAdjutantStateDir({ env })));
  const accountId = normalizeAccountId(env.ADJUTANT_SLACK_ACCOUNT_ID, "default");
  const slackCacheBaseDir = resolveSlackCacheBaseDir({ dataDir, accountId });

  const authProvider = new SlackAuthProvider({
    xoxcToken: env.ADJUTANT_SLACK_XOXC_TOKEN,
    xoxdToken: env.ADJUTANT_SLACK_XOXD_TOKEN,
    tokenStateProvider: () => {
      const cached = resolveSlackAuthTokensFromCache({
        accountId,
      });
      if (!cached) {
        return null;
      }
      return {
        xoxcToken: cached.xoxcToken,
        xoxdToken: cached.xoxdToken,
      };
    },
  });

  const requestTimeoutMs = Math.max(
    1,
    Number.isFinite(Number(env.ADJUTANT_SLACK_API_TIMEOUT_MS))
      ? Math.floor(Number(env.ADJUTANT_SLACK_API_TIMEOUT_MS))
      : 10_000
  );

  const teamClient = new SlackRouteClient({
    mode: "team",
    apiBaseUrl: readString(env.ADJUTANT_SLACK_TEAM_API_BASE_URL, "https://slack.com/api"),
    authProvider,
    fetchFn: options.fetchFn,
    timeoutMs: requestTimeoutMs,
  });

  const enterpriseClient = new SlackRouteClient({
    mode: "enterprise",
    apiBaseUrl: readString(env.ADJUTANT_SLACK_ENTERPRISE_API_BASE_URL, "https://slack.com/api"),
    authProvider,
    fetchFn: options.fetchFn,
    timeoutMs: requestTimeoutMs,
  });

  const routeStore = new WorkspaceRoutePinStore({
    filePath: readString(
      env.ADJUTANT_SLACK_ROUTE_PIN_PATH,
      join(slackCacheBaseDir, "workspace-route-pins.json")
    ),
    now: options.now,
  });

  const fallbackExecutor = new SlackFallbackExecutor({
    routeStore,
    now: () => (options.now ? options.now().getTime() : Date.now()),
  });

  const nameCacheRepository = new SlackNameCacheRepository({
    channelCachePath: join(slackCacheBaseDir, "channel-names-by-team.json"),
    userCachePath: join(slackCacheBaseDir, "user-names-by-team.json"),
    now: options.now,
  });

  const service = new SlackApiService({
    authProvider,
    teamClient,
    enterpriseClient,
    nameCacheRepository,
    routeStore,
    fallbackExecutor,
    defaultRoutingMode: normalizeSlackRoutingMode(
      env.ADJUTANT_SLACK_API_ROUTING_MODE,
      "auto_probe"
    ),
    now: () => (options.now ? options.now().getTime() : Date.now()),
  });

  return createSlackDynamicProvider(service);
}
