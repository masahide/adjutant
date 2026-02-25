import { join, resolve } from "node:path";
import { parseBooleanEnv } from "../../runtime/env-parsers.js";
import { resolveDefaultDataDir, resolveSlackCacheBaseDir } from "../../runtime/data-paths.js";
import { resolveEndpoint } from "../../runtime/config.js";
import { resolveAdjutantStateDir } from "../session-paths.js";
import { SlackNameCacheRepository } from "../../slack/nameCacheRepository.js";
import {
  configureSlackAuthTokenRegistry,
  listSlackAuthWorkspacesFromCache,
  resolveSlackAuthTokensFromCache,
} from "../../slack/slackAuthTokenRegistry.js";
import { SLACK_PENDING_ACCOUNT_ID } from "../../slack/slackAuthTokenStore.js";
import { SlackAuthProvider } from "./auth-provider.js";
import { SlackRouteClient, type SlackBrowserApiInvoker } from "./route-client.js";
import { WorkspaceRoutePinStore } from "./workspace-route-pin-store.js";
import { SlackFallbackExecutor } from "./fallback-executor.js";
import { createSlackDynamicProvider } from "./provider.js";
import { normalizeSlackRoutingMode, type SlackRouteStore } from "./types.js";
import { SlackApiService } from "./service.js";

export function isSlackApiToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanEnv(env.ADJUTANT_SLACK_API_ENABLED, true);
}

export type CreateSlackDynamicProviderFromEnvOptions = {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  dataDir?: string;
  now?: () => Date;
  browserInvoker?: SlackBrowserApiInvoker;
};

export function createSlackDynamicProviderFromEnv(
  options: CreateSlackDynamicProviderFromEnvOptions = {}
) {
  const env = options.env ?? process.env;
  const slackApiRequestEnabled = parseBooleanEnv(env.ADJUTANT_SLACK_API_REQUEST_ENABLED, true);
  const slackAuthTestEnabled = parseBooleanEnv(env.ADJUTANT_SLACK_AUTH_TEST_ENABLED, true);
  const endpoint = resolveEndpoint();
  const cdpHost = env.ADJUTANT_SLACK_CDP_HOST?.trim() || endpoint.host;
  const cdpPortRaw = env.ADJUTANT_SLACK_CDP_PORT?.trim();
  const cdpPort = Number.isFinite(Number(cdpPortRaw))
    ? Math.max(1, Math.floor(Number(cdpPortRaw)))
    : endpoint.port;
  const dataDir =
    options.dataDir?.trim() ??
    (env.DATA_DIR?.trim()
      ? resolve(env.DATA_DIR)
      : resolveDefaultDataDir(resolveAdjutantStateDir({ env })));
  const slackCacheBaseDir = resolveSlackCacheBaseDir({
    dataDir,
    accountId: SLACK_PENDING_ACCOUNT_ID,
    fallbackAccountId: SLACK_PENDING_ACCOUNT_ID,
  });

  configureSlackAuthTokenRegistry({
    dataDir,
    authTestEnabled: slackAuthTestEnabled,
    fetchFn: options.fetchFn,
  });

  const authProvider = new SlackAuthProvider({
    tokenStateProvider: (workspaceKey) => {
      const cached = resolveSlackAuthTokensFromCache({
        workspaceKey,
      });
      if (!cached) {
        return null;
      }
      return {
        xoxcToken: cached.xoxcToken,
        xoxdToken: cached.xoxdToken,
        workspaceKey: cached.workspaceKey,
        authTest: cached.authTest,
      };
    },
  });

  const teamClient = new SlackRouteClient({
    mode: "team",
    authProvider,
    requestEnabled: slackApiRequestEnabled,
    browserInvoker: options.browserInvoker,
    cdpHost,
    cdpPort,
  });

  const enterpriseClient = new SlackRouteClient({
    mode: "enterprise",
    authProvider,
    requestEnabled: slackApiRequestEnabled,
    browserInvoker: options.browserInvoker,
    cdpHost,
    cdpPort,
  });

  const routePinPathOverride = asNonEmptyString(env.ADJUTANT_SLACK_ROUTE_PIN_PATH);
  const routeStore = routePinPathOverride
    ? new WorkspaceRoutePinStore({
        filePath: routePinPathOverride,
        now: options.now,
      })
    : createCompositeRouteStore({
        dataDir,
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
    workspaceListProvider: listSlackAuthWorkspacesFromCache,
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

function asNonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function resolveRoutePinPath(dataDir: string, accountId: string): string {
  return join(
    resolveSlackCacheBaseDir({
      dataDir,
      accountId,
      fallbackAccountId: SLACK_PENDING_ACCOUNT_ID,
    }),
    "workspace-route-pins.json"
  );
}

function createCompositeRouteStore(input: { dataDir: string; now?: () => Date }): SlackRouteStore {
  const pendingStore = new WorkspaceRoutePinStore({
    filePath: resolveRoutePinPath(input.dataDir, SLACK_PENDING_ACCOUNT_ID),
    now: input.now,
  });
  const byAccount = new Map<string, WorkspaceRoutePinStore>();

  const accountStoreFor = (accountId: string): WorkspaceRoutePinStore => {
    const key = accountId.trim();
    const cached = byAccount.get(key);
    if (cached) {
      return cached;
    }
    const created = new WorkspaceRoutePinStore({
      filePath: resolveRoutePinPath(input.dataDir, key),
      now: input.now,
    });
    byAccount.set(key, created);
    return created;
  };

  const resolveAccountStore = (workspaceKey: string): WorkspaceRoutePinStore | null => {
    const accountId = resolveSlackAuthTokensFromCache({ workspaceKey })?.accountId;
    if (!accountId) {
      return null;
    }
    return accountStoreFor(accountId);
  };

  return {
    get: async (workspaceKey) => {
      const accountStore = resolveAccountStore(workspaceKey);
      if (accountStore) {
        const fromAccount = await accountStore.get(workspaceKey);
        if (fromAccount) {
          return fromAccount;
        }
      }
      return pendingStore.get(workspaceKey);
    },
    set: async (pin) => {
      const accountStore = resolveAccountStore(pin.workspaceKey);
      if (accountStore) {
        await accountStore.set(pin);
        return;
      }
      await pendingStore.set(pin);
    },
  };
}
