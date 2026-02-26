import { SlackRpcMcpClient } from "../assistant/slack-api-tools/slack-rpc-client.js";
import { parseBooleanEnv, parsePositiveIntEnv, parseStringEnv } from "../runtime/env-parsers.js";
import type { SlackWorkspaceTokenPairReadyEvent } from "./slackAuthTokenRegistry.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_TIMEOUT_MS = 120_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseTextJson(text: string | undefined): Record<string, unknown> | null {
  const raw = asString(text);
  if (!raw) {
    return null;
  }
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

function extractToolPayload(input: {
  structuredContent?: unknown;
  text?: string;
}): Record<string, unknown> | null {
  const structured = asRecord(input.structuredContent);
  if (structured) {
    return structured;
  }
  return parseTextJson(input.text);
}

function buildScopeKey(event: SlackWorkspaceTokenPairReadyEvent): string {
  const accountId = asString(event.accountId) ?? "pending";
  return `${accountId}:${event.workspaceKey}`;
}

function buildTokenKey(event: SlackWorkspaceTokenPairReadyEvent): string {
  return `${event.xoxcToken}\n${event.xoxdToken}`;
}

export type SlackRpcWorkspaceRegistrarOptions = {
  enabled: boolean;
  rpcClient: SlackRpcMcpClient;
  onInfo?: (message: string, meta?: Record<string, unknown>) => void;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
};

export type CreateSlackRpcWorkspaceRegistrarFromEnvOptions = {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  onInfo?: (message: string, meta?: Record<string, unknown>) => void;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
};

export class SlackRpcWorkspaceRegistrar {
  private readonly enabled: boolean;
  private readonly rpcClient: SlackRpcMcpClient;
  private readonly onInfo: ((message: string, meta?: Record<string, unknown>) => void) | undefined;
  private readonly onWarn: ((message: string, meta?: Record<string, unknown>) => void) | undefined;
  private readonly registeredTokenByScope = new Map<string, string>();
  private readonly registeredTokens = new Set<string>();
  private readonly registeredWorkspaceByToken = new Map<string, string>();
  private readonly inFlightByScope = new Map<string, Promise<void>>();
  private readonly inFlightByToken = new Map<string, Promise<void>>();

  constructor(options: SlackRpcWorkspaceRegistrarOptions) {
    this.enabled = options.enabled;
    this.rpcClient = options.rpcClient;
    this.onInfo = options.onInfo;
    this.onWarn = options.onWarn;
  }

  async registerTokenPair(event: SlackWorkspaceTokenPairReadyEvent): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const scopeKey = buildScopeKey(event);
    const tokenKey = buildTokenKey(event);
    if (this.registeredTokenByScope.get(scopeKey) === tokenKey) {
      this.onInfo?.("slack-rpc-workspace-register-skipped", {
        reason: "duplicate_token_pair",
        workspaceKey: event.workspaceKey,
        accountId: event.accountId,
      });
      return;
    }
    if (this.registeredTokens.has(tokenKey)) {
      this.registeredTokenByScope.set(scopeKey, tokenKey);
      this.onInfo?.("slack-rpc-workspace-register-skipped", {
        reason: "duplicate_token_pair_any_scope",
        workspaceKey: event.workspaceKey,
        accountId: event.accountId,
        registeredWorkspaceKey: this.registeredWorkspaceByToken.get(tokenKey),
      });
      return;
    }
    const tokenInFlight = this.inFlightByToken.get(tokenKey);
    if (tokenInFlight) {
      this.onInfo?.("slack-rpc-workspace-register-waiting", {
        reason: "in_flight_token_pair",
        workspaceKey: event.workspaceKey,
        accountId: event.accountId,
      });
      await tokenInFlight;
      return;
    }
    const inFlight = this.inFlightByScope.get(scopeKey);
    if (inFlight) {
      this.onInfo?.("slack-rpc-workspace-register-waiting", {
        reason: "in_flight",
        workspaceKey: event.workspaceKey,
        accountId: event.accountId,
      });
      await inFlight;
      return;
    }
    const task = this.registerTokenPairInternal({ scopeKey, tokenKey, event }).finally(() => {
      this.inFlightByScope.delete(scopeKey);
      if (this.inFlightByToken.get(tokenKey) === task) {
        this.inFlightByToken.delete(tokenKey);
      }
    });
    this.inFlightByScope.set(scopeKey, task);
    this.inFlightByToken.set(tokenKey, task);
    await task;
  }

  private async registerTokenPairInternal(input: {
    scopeKey: string;
    tokenKey: string;
    event: SlackWorkspaceTokenPairReadyEvent;
  }): Promise<void> {
    const startedAt = Date.now();
    this.onInfo?.("slack-rpc-workspace-register-start", {
      workspaceKey: input.event.workspaceKey,
      accountId: input.event.accountId,
      aliasCount: input.event.aliases.length,
    });
    const first = await this.callWorkspaceRegister({
      xoxc: input.event.xoxcToken,
      xoxd: input.event.xoxdToken,
    });
    const durationMs = Date.now() - startedAt;
    if (first.ok) {
      this.registeredTokenByScope.set(input.scopeKey, input.tokenKey);
      this.registeredTokens.add(input.tokenKey);
      const registeredWorkspaceKey = asString(first.workspaceKey);
      if (registeredWorkspaceKey) {
        this.registeredWorkspaceByToken.set(input.tokenKey, registeredWorkspaceKey);
      }
      this.onInfo?.("slack-rpc-workspace-register-succeeded", {
        workspaceKey: input.event.workspaceKey,
        accountId: input.event.accountId,
        registeredWorkspaceKey: first.workspaceKey,
        authTest: first.authTest,
        code: first.code,
        durationMs,
      });
      return;
    }

    this.onWarn?.("slack-rpc-workspace-register-failed", {
      workspaceKey: input.event.workspaceKey,
      accountId: input.event.accountId,
      code: first.code,
      message: first.message,
      durationMs,
    });
  }

  private async callWorkspaceRegister(args: Record<string, unknown>): Promise<{
    ok: boolean;
    code: string;
    message: string;
    workspaceKey?: string;
    authTest?: Record<string, unknown>;
  }> {
    try {
      const result = await this.rpcClient.callTool("workspace_register", args);
      const payload = extractToolPayload({
        structuredContent: result.structuredContent,
        text: result.text,
      });
      if (result.isError || payload?.ok === false) {
        const code = asString(payload?.code) ?? "api_error";
        const message = asString(payload?.message) ?? result.text ?? "workspace_register failed";
        if (code === "already_exists") {
          return {
            ok: true,
            code,
            message,
            workspaceKey: extractRegisteredWorkspaceKey(payload),
            authTest: extractAuthTest(payload),
          };
        }
        return {
          ok: false,
          code,
          message,
        };
      }
      return {
        ok: true,
        code: "ok",
        message: "workspace_register succeeded",
        workspaceKey: extractRegisteredWorkspaceKey(payload),
        authTest: extractAuthTest(payload),
      };
    } catch (error) {
      return {
        ok: false,
        code: "integration_unavailable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function createSlackRpcWorkspaceRegistrarFromEnv(
  options: CreateSlackRpcWorkspaceRegistrarFromEnvOptions = {}
): SlackRpcWorkspaceRegistrar {
  const env = options.env ?? process.env;
  const enabled = parseBooleanEnv(env.ADJUTANT_SLACK_RPC_ENABLED, true);
  const baseUrl = parseStringEnv(env.ADJUTANT_SLACK_RPC_BASE_URL, DEFAULT_BASE_URL);
  const timeoutMs = parsePositiveIntEnv(env.ADJUTANT_SLACK_RPC_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const rpcClient = new SlackRpcMcpClient({
    baseUrl,
    timeoutMs,
    fetchFn: options.fetchFn,
  });
  return new SlackRpcWorkspaceRegistrar({
    enabled,
    rpcClient,
    onInfo: options.onInfo,
    onWarn: options.onWarn,
  });
}

function extractRegisteredWorkspaceKey(payload: Record<string, unknown> | null): string | undefined {
  const workspace = asRecord(payload?.workspace);
  return asString(workspace?.workspace_key) ?? asString(payload?.workspace_key);
}

function extractAuthTest(payload: Record<string, unknown> | null): Record<string, unknown> | undefined {
  return asRecord(payload?.auth_test) ?? asRecord(asRecord(payload?.workspace)?.auth_test) ?? undefined;
}
