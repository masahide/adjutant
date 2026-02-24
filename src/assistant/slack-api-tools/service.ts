import type { SlackNameCacheRepository } from "../../slack/nameCacheRepository.js";
import { SlackRouteError } from "./route-client.js";
import {
  createSlackApiError,
  createSlackApiSuccess,
  normalizeSlackRoutingMode,
  type SlackApiResult,
  type SlackAuthTestResult,
  type SlackChannel,
  type SlackMode,
  type SlackPostMessageResult,
  type SlackRouteStore,
  type SlackRoutingMode,
  type SlackSearchMessage,
  type SlackUser,
} from "./types.js";
import { SlackFallbackExecutor } from "./fallback-executor.js";
import type { SlackAuthProvider } from "./auth-provider.js";

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function modeFromRoutingMode(routingMode: SlackRoutingMode): SlackMode {
  return routingMode === "manual_enterprise" ? "enterprise" : "team";
}

function formatRouteError(error: SlackRouteError): string {
  const slackError = error.slackError;
  if (slackError) {
    return `${error.mode}:${error.kind}:${slackError}`;
  }
  return `${error.mode}:${error.kind}:${error.message}`;
}

function toOperationError(operation: string, error: SlackRouteError) {
  if (error.kind === "rate_limited") {
    return createSlackApiError({
      code: "rate_limited",
      message: `${operation} is rate limited`,
      primaryError: formatRouteError(error),
    });
  }
  if (error.kind === "auth_invalid") {
    return createSlackApiError({
      code: "auth_invalid",
      message: "xoxc/xoxd token is invalid",
      primaryError: formatRouteError(error),
    });
  }
  if (error.kind === "not_found") {
    return createSlackApiError({
      code: "not_found",
      message: `${operation} target not found`,
      primaryError: formatRouteError(error),
    });
  }
  return createSlackApiError({
    code: "primary_failed",
    message: `${operation} failed`,
    primaryError: formatRouteError(error),
  });
}

function toSlackUserProfile(user: SlackUser) {
  return {
    real_name: user.realName,
    profile: {
      display_name: user.profile?.displayName,
      email: user.profile?.email,
      first_name: user.profile?.firstName,
      last_name: user.profile?.lastName,
      image_original: user.profile?.imageOriginal,
    },
  };
}

function normalizeWorkspaceKey(value: string | undefined): string {
  return asString(value) ?? "global";
}

export type SlackRouteClientLike = {
  authTest: () => Promise<SlackAuthTestResult>;
  listUsers: () => Promise<SlackUser[]>;
  listChannels: () => Promise<SlackChannel[]>;
  getUserInfo: (userId: string) => Promise<SlackUser | null>;
  getChannelInfo: (channelId: string) => Promise<SlackChannel | null>;
  searchMessages: (query: string, limit?: number) => Promise<{ messages: SlackSearchMessage[] }>;
  postMessage: (channelId: string, text: string) => Promise<SlackPostMessageResult>;
};

export type SlackApiServiceOptions = {
  authProvider: SlackAuthProvider;
  teamClient: SlackRouteClientLike;
  enterpriseClient: SlackRouteClientLike;
  nameCacheRepository: SlackNameCacheRepository;
  routeStore: SlackRouteStore;
  fallbackExecutor: SlackFallbackExecutor;
  defaultRoutingMode?: SlackRoutingMode;
  now?: () => number;
};

export class SlackApiService {
  private readonly authProvider: SlackAuthProvider;
  private readonly teamClient: SlackRouteClientLike;
  private readonly enterpriseClient: SlackRouteClientLike;
  private readonly nameCacheRepository: SlackNameCacheRepository;
  private readonly routeStore: SlackRouteStore;
  private readonly fallbackExecutor: SlackFallbackExecutor;
  private readonly defaultRoutingMode: SlackRoutingMode;
  private readonly now: () => number;
  private loadPromise: Promise<void> | null = null;

  constructor(options: SlackApiServiceOptions) {
    this.authProvider = options.authProvider;
    this.teamClient = options.teamClient;
    this.enterpriseClient = options.enterpriseClient;
    this.nameCacheRepository = options.nameCacheRepository;
    this.routeStore = options.routeStore;
    this.fallbackExecutor = options.fallbackExecutor;
    this.defaultRoutingMode = options.defaultRoutingMode ?? "auto_probe";
    this.now = options.now ?? (() => Date.now());
  }

  async getUserNameById(args: {
    user_id?: unknown;
    team_id?: unknown;
    channel_id?: unknown;
    routing_mode?: unknown;
    workspace_key?: unknown;
  }): Promise<
    SlackApiResult<{ user_id: string; name: string; source: "memory_cache" | "api_refresh" }>
  > {
    const authError = this.authProvider.validate();
    if (authError) {
      return authError;
    }

    const userId = asString(args.user_id);
    if (!userId) {
      return createSlackApiError({
        code: "validation_error",
        message: "user_id is required",
      });
    }

    await this.ensureCacheLoaded();

    const teamIdHint = asString(args.team_id);
    const channelIdHint = asString(args.channel_id);
    const cached = this.nameCacheRepository.resolveUserName(userId, teamIdHint, channelIdHint);
    if (cached) {
      return createSlackApiSuccess({
        data: {
          user_id: userId,
          name: cached,
          source: "memory_cache",
        },
      });
    }

    const routingMode = this.resolveRoutingMode(args.routing_mode);
    const workspaceKey = await this.resolveWorkspaceKey(asString(args.workspace_key));
    const modeResult = await this.resolveModeForRead(routingMode, workspaceKey);
    if (!modeResult.ok) {
      return modeResult;
    }

    const client = this.clientForMode(modeResult.data);
    try {
      const user = await client.getUserInfo(userId);
      if (!user) {
        return createSlackApiError({
          code: "not_found",
          message: `user not found: ${userId}`,
        });
      }

      await this.nameCacheRepository.updateUsers([
        {
          teamId: user.teamId,
          userId: user.id,
          user: toSlackUserProfile(user),
        },
      ]);

      const resolved = this.nameCacheRepository.resolveUserName(userId, user.teamId, channelIdHint);
      if (!resolved) {
        return createSlackApiError({
          code: "not_found",
          message: `user not found: ${userId}`,
        });
      }

      return createSlackApiSuccess({
        data: {
          user_id: userId,
          name: resolved,
          source: "api_refresh",
        },
        modeUsed: modeResult.data,
        fallbackTried: false,
      });
    } catch (error) {
      const routeError =
        error instanceof SlackRouteError
          ? error
          : new SlackRouteError({
              kind: "api_error",
              mode: modeResult.data,
              message: error instanceof Error ? error.message : String(error),
            });
      return toOperationError("get_user_name_by_id", routeError);
    }
  }

  async getChannelNameById(args: {
    channel_id?: unknown;
    team_id?: unknown;
    routing_mode?: unknown;
    workspace_key?: unknown;
  }): Promise<
    SlackApiResult<{ channel_id: string; name: string; source: "memory_cache" | "api_refresh" }>
  > {
    const authError = this.authProvider.validate();
    if (authError) {
      return authError;
    }

    const channelId = asString(args.channel_id);
    if (!channelId) {
      return createSlackApiError({
        code: "validation_error",
        message: "channel_id is required",
      });
    }

    await this.ensureCacheLoaded();

    const teamIdHint = asString(args.team_id);
    const cached = this.nameCacheRepository.resolveChannelName(channelId, teamIdHint);
    if (cached) {
      return createSlackApiSuccess({
        data: {
          channel_id: channelId,
          name: cached,
          source: "memory_cache",
        },
      });
    }

    const routingMode = this.resolveRoutingMode(args.routing_mode);
    const workspaceKey = await this.resolveWorkspaceKey(asString(args.workspace_key));
    const modeResult = await this.resolveModeForRead(routingMode, workspaceKey);
    if (!modeResult.ok) {
      return modeResult;
    }

    const client = this.clientForMode(modeResult.data);
    try {
      const channel = await client.getChannelInfo(channelId);
      if (!channel) {
        return createSlackApiError({
          code: "not_found",
          message: `channel not found: ${channelId}`,
        });
      }

      await this.nameCacheRepository.updateChannels([
        {
          teamId: channel.teamId,
          channelId: channel.id,
          channelName: channel.name,
        },
      ]);

      const resolved = this.nameCacheRepository.resolveChannelName(channelId, channel.teamId);
      if (!resolved) {
        return createSlackApiError({
          code: "not_found",
          message: `channel not found: ${channelId}`,
        });
      }

      return createSlackApiSuccess({
        data: {
          channel_id: channelId,
          name: resolved,
          source: "api_refresh",
        },
        modeUsed: modeResult.data,
        fallbackTried: false,
      });
    } catch (error) {
      const routeError =
        error instanceof SlackRouteError
          ? error
          : new SlackRouteError({
              kind: "api_error",
              mode: modeResult.data,
              message: error instanceof Error ? error.message : String(error),
            });
      return toOperationError("get_channel_name_by_id", routeError);
    }
  }

  async listUsers(args: {
    routing_mode?: unknown;
    workspace_key?: unknown;
  }): Promise<SlackApiResult<{ users: SlackUser[] }>> {
    const authError = this.authProvider.validate();
    if (authError) {
      return authError;
    }

    await this.ensureCacheLoaded();
    const routingMode = this.resolveRoutingMode(args.routing_mode);
    const workspaceKey = await this.resolveWorkspaceKey(asString(args.workspace_key));
    const modeResult = await this.resolveModeForRead(routingMode, workspaceKey);
    if (!modeResult.ok) {
      return modeResult;
    }

    const mode = modeResult.data;
    const client = this.clientForMode(mode);
    try {
      const users = await client.listUsers();
      await this.nameCacheRepository.updateUsers(
        users.map((user) => ({
          teamId: user.teamId,
          userId: user.id,
          user: toSlackUserProfile(user),
        }))
      );

      return createSlackApiSuccess({
        data: { users },
        modeUsed: mode,
        fallbackTried: false,
      });
    } catch (error) {
      const routeError =
        error instanceof SlackRouteError
          ? error
          : new SlackRouteError({
              kind: "api_error",
              mode,
              message: error instanceof Error ? error.message : String(error),
            });
      return toOperationError("users_list", routeError);
    }
  }

  async listChannels(args: {
    routing_mode?: unknown;
    workspace_key?: unknown;
  }): Promise<SlackApiResult<{ channels: SlackChannel[] }>> {
    const authError = this.authProvider.validate();
    if (authError) {
      return authError;
    }

    await this.ensureCacheLoaded();
    const routingMode = this.resolveRoutingMode(args.routing_mode);
    const workspaceKey = await this.resolveWorkspaceKey(asString(args.workspace_key));
    const modeResult = await this.resolveModeForRead(routingMode, workspaceKey);
    if (!modeResult.ok) {
      return modeResult;
    }

    const mode = modeResult.data;
    const client = this.clientForMode(mode);
    try {
      const channels = await client.listChannels();
      await this.nameCacheRepository.updateChannels(
        channels.map((channel) => ({
          teamId: channel.teamId,
          channelId: channel.id,
          channelName: channel.name,
        }))
      );

      return createSlackApiSuccess({
        data: { channels },
        modeUsed: mode,
        fallbackTried: false,
      });
    } catch (error) {
      const routeError =
        error instanceof SlackRouteError
          ? error
          : new SlackRouteError({
              kind: "api_error",
              mode,
              message: error instanceof Error ? error.message : String(error),
            });
      return toOperationError("channels_list", routeError);
    }
  }

  async searchMessages(args: {
    query?: unknown;
    limit?: unknown;
    routing_mode?: unknown;
    workspace_key?: unknown;
  }): Promise<SlackApiResult<{ messages: SlackSearchMessage[] }>> {
    const authError = this.authProvider.validate();
    if (authError) {
      return authError;
    }

    const query = asString(args.query);
    if (!query) {
      return createSlackApiError({
        code: "validation_error",
        message: "query is required",
      });
    }

    const limit = asPositiveInt(args.limit) ?? 20;
    const routingMode = this.resolveRoutingMode(args.routing_mode);
    const workspaceKey = await this.resolveWorkspaceKey(asString(args.workspace_key));
    const executed = await this.fallbackExecutor.runWithFallback({
      routingMode,
      workspaceKey,
      operationName: "search_messages",
      probeMode: async () => this.probeMode(workspaceKey),
      execute: async (mode) => this.clientForMode(mode).searchMessages(query, limit),
    });

    if (!executed.ok) {
      return executed;
    }

    return createSlackApiSuccess({
      data: executed.data.data,
      modeUsed: executed.data.modeUsed,
      fallbackTried: executed.data.fallbackTried,
    });
  }

  async postMessage(args: {
    channel_id?: unknown;
    text?: unknown;
    routing_mode?: unknown;
    workspace_key?: unknown;
  }): Promise<SlackApiResult<SlackPostMessageResult>> {
    const authError = this.authProvider.validate();
    if (authError) {
      return authError;
    }

    const channelId = asString(args.channel_id);
    if (!channelId) {
      return createSlackApiError({
        code: "validation_error",
        message: "channel_id is required",
      });
    }

    const text = asString(args.text);
    if (!text) {
      return createSlackApiError({
        code: "validation_error",
        message: "text is required",
      });
    }

    const routingMode = this.resolveRoutingMode(args.routing_mode);
    const workspaceKey = await this.resolveWorkspaceKey(asString(args.workspace_key));
    const executed = await this.fallbackExecutor.runWithFallback({
      routingMode,
      workspaceKey,
      operationName: "post_message",
      probeMode: async () => this.probeMode(workspaceKey),
      execute: async (mode) => this.clientForMode(mode).postMessage(channelId, text),
    });

    if (!executed.ok) {
      return executed;
    }

    return createSlackApiSuccess({
      data: executed.data.data,
      modeUsed: executed.data.modeUsed,
      fallbackTried: executed.data.fallbackTried,
    });
  }

  private resolveRoutingMode(value: unknown): SlackRoutingMode {
    return normalizeSlackRoutingMode(value, this.defaultRoutingMode);
  }

  private clientForMode(mode: SlackMode): SlackRouteClientLike {
    return mode === "enterprise" ? this.enterpriseClient : this.teamClient;
  }

  private async ensureCacheLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.nameCacheRepository.load();
    }
    await this.loadPromise;
  }

  private async resolveWorkspaceKey(inputWorkspaceKey: string | undefined): Promise<string> {
    const explicit = asString(inputWorkspaceKey);
    if (explicit) {
      return explicit;
    }

    try {
      const teamInfo = await this.teamClient.authTest();
      return (
        asString(teamInfo.enterpriseId) ??
        asString(teamInfo.teamId) ??
        normalizeWorkspaceKey(undefined)
      );
    } catch {
      try {
        const enterpriseInfo = await this.enterpriseClient.authTest();
        return (
          asString(enterpriseInfo.enterpriseId) ??
          asString(enterpriseInfo.teamId) ??
          normalizeWorkspaceKey(undefined)
        );
      } catch {
        return normalizeWorkspaceKey(undefined);
      }
    }
  }

  private async probeMode(workspaceKey: string): Promise<SlackMode> {
    try {
      await this.teamClient.authTest();
      await this.routeStore.set({ workspaceKey, mode: "team", decidedAt: this.now() });
      return "team";
    } catch (teamError) {
      const teamRouteError =
        teamError instanceof SlackRouteError
          ? teamError
          : new SlackRouteError({
              kind: "api_error",
              mode: "team",
              message: teamError instanceof Error ? teamError.message : String(teamError),
            });
      if (teamRouteError.kind === "auth_invalid" || teamRouteError.kind === "rate_limited") {
        throw teamRouteError;
      }

      await this.enterpriseClient.authTest();
      await this.routeStore.set({ workspaceKey, mode: "enterprise", decidedAt: this.now() });
      return "enterprise";
    }
  }

  private async resolveModeForRead(
    routingMode: SlackRoutingMode,
    workspaceKey: string
  ): Promise<SlackApiResult<SlackMode>> {
    if (routingMode !== "auto_probe") {
      return createSlackApiSuccess({ data: modeFromRoutingMode(routingMode) });
    }

    const pinned = await this.routeStore.get(workspaceKey);
    if (pinned) {
      return createSlackApiSuccess({ data: pinned.mode });
    }

    try {
      const probedMode = await this.probeMode(workspaceKey);
      await this.routeStore.set({
        workspaceKey,
        mode: probedMode,
        decidedAt: this.now(),
      });
      return createSlackApiSuccess({ data: probedMode });
    } catch (error) {
      const routeError =
        error instanceof SlackRouteError
          ? error
          : new SlackRouteError({
              kind: "api_error",
              mode: "team",
              message: error instanceof Error ? error.message : String(error),
            });
      return toOperationError("auto_probe", routeError);
    }
  }
}
