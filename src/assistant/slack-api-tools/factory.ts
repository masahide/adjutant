import { parseBooleanEnv, parsePositiveIntEnv, parseStringEnv } from "../../runtime/env-parsers.js";
import { createSlackDynamicProvider } from "./provider.js";
import { SlackRpcMcpClient } from "./slack-rpc-client.js";
import { SlackApiService } from "./service.js";

export function isSlackApiToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanEnv(env.ADJUTANT_SLACK_API_ENABLED, true);
}

export type CreateSlackDynamicProviderFromEnvOptions = {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  // Legacy options kept for compatibility with existing callsites/tests.
  dataDir?: string;
  now?: () => Date;
  browserInvoker?: unknown;
  skipRegistryConfigure?: boolean;
};

export function createSlackDynamicProviderFromEnv(
  options: CreateSlackDynamicProviderFromEnvOptions = {}
) {
  const env = options.env ?? process.env;
  const rpcEnabled = parseBooleanEnv(env.ADJUTANT_SLACK_RPC_ENABLED, true);
  const baseUrl = parseStringEnv(env.ADJUTANT_SLACK_RPC_BASE_URL, "http://127.0.0.1:8080");
  const timeoutMs = parsePositiveIntEnv(env.ADJUTANT_SLACK_RPC_TIMEOUT_MS, 120_000);

  const rpcClient = new SlackRpcMcpClient({
    baseUrl,
    fetchFn: options.fetchFn,
    timeoutMs,
  });

  const service = new SlackApiService({
    rpcClient,
  });

  if (!rpcEnabled) {
    return {
      name: "slack",
      description: "Slack RPC Gateway tools (disabled)",
      listActions: () => [],
      getAction: () => undefined,
    };
  }

  return createSlackDynamicProvider(service);
}
