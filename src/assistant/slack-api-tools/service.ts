import { SlackRpcClientError, type SlackRpcMcpClient } from "./slack-rpc-client.js";
import {
  createSlackApiError,
  createSlackApiSuccess,
  type SlackApiErrorCode,
  type SlackApiResult,
} from "./types.js";

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

function hasWorkspaceKey(args: Record<string, unknown>): boolean {
  return Boolean(asString(args.workspace_key));
}

const KNOWN_ERROR_CODES: ReadonlySet<SlackApiErrorCode> = new Set([
  "auth_invalid",
  "primary_failed",
  "fallback_failed",
  "rate_limited",
  "not_found",
  "validation_error",
  "integration_unavailable",
  "timeout",
  "api_error",
]);

function normalizeErrorCode(value: unknown): SlackApiErrorCode {
  const raw = asString(value);
  if (raw && KNOWN_ERROR_CODES.has(raw as SlackApiErrorCode)) {
    return raw as SlackApiErrorCode;
  }
  return "api_error";
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

export type SlackApiServiceOptions = {
  rpcClient: SlackRpcMcpClient;
};

export class SlackApiService {
  private readonly rpcClient: SlackRpcMcpClient;

  constructor(options: SlackApiServiceOptions) {
    this.rpcClient = options.rpcClient;
  }

  async listWorkspaces(
    _args: Record<string, unknown>
  ): Promise<SlackApiResult<Record<string, unknown>>> {
    return await this.executeTool({
      actionName: "workspaces_list",
      args: {},
      workspaceKeyRequired: false,
    });
  }

  async workspaceRegister(
    args: Record<string, unknown>
  ): Promise<SlackApiResult<Record<string, unknown>>> {
    return await this.executeTool({
      actionName: "workspace_register",
      args,
      workspaceKeyRequired: false,
    });
  }

  async workspaceUnregister(
    args: Record<string, unknown>
  ): Promise<SlackApiResult<Record<string, unknown>>> {
    return await this.executeTool({
      actionName: "workspace_unregister",
      args,
      workspaceKeyRequired: true,
    });
  }

  async listUsers(args: Record<string, unknown>): Promise<SlackApiResult<Record<string, unknown>>> {
    return await this.executeTool({
      actionName: "users_list",
      args,
      workspaceKeyRequired: true,
    });
  }

  async listChannels(
    args: Record<string, unknown>
  ): Promise<SlackApiResult<Record<string, unknown>>> {
    return await this.executeTool({
      actionName: "channels_list",
      args,
      workspaceKeyRequired: true,
    });
  }

  async getUserInfo(
    args: Record<string, unknown>
  ): Promise<SlackApiResult<Record<string, unknown>>> {
    return await this.executeTool({
      actionName: "get_user_info",
      args,
      workspaceKeyRequired: true,
    });
  }

  async getChannelInfo(
    args: Record<string, unknown>
  ): Promise<SlackApiResult<Record<string, unknown>>> {
    return await this.executeTool({
      actionName: "get_channel_info",
      args,
      workspaceKeyRequired: true,
    });
  }

  async getUserNameById(
    args: Record<string, unknown>
  ): Promise<SlackApiResult<Record<string, unknown>>> {
    return await this.executeTool({
      actionName: "get_user_name_by_id",
      args,
      workspaceKeyRequired: true,
    });
  }

  async getChannelNameById(
    args: Record<string, unknown>
  ): Promise<SlackApiResult<Record<string, unknown>>> {
    return await this.executeTool({
      actionName: "get_channel_name_by_id",
      args,
      workspaceKeyRequired: true,
    });
  }

  async searchMessages(
    args: Record<string, unknown>
  ): Promise<SlackApiResult<Record<string, unknown>>> {
    return await this.executeTool({
      actionName: "search_messages",
      args,
      workspaceKeyRequired: true,
    });
  }

  async postMessage(
    args: Record<string, unknown>
  ): Promise<SlackApiResult<Record<string, unknown>>> {
    return await this.executeTool({
      actionName: "post_message",
      args,
      workspaceKeyRequired: true,
    });
  }

  async authTest(args: Record<string, unknown>): Promise<SlackApiResult<Record<string, unknown>>> {
    return await this.executeTool({
      actionName: "auth_test",
      args,
      workspaceKeyRequired: true,
    });
  }

  private async executeTool(input: {
    actionName: string;
    args: Record<string, unknown>;
    workspaceKeyRequired: boolean;
  }): Promise<SlackApiResult<Record<string, unknown>>> {
    if (input.workspaceKeyRequired && !hasWorkspaceKey(input.args)) {
      return createSlackApiError({
        code: "validation_error",
        message: "workspace_key is required",
      });
    }

    try {
      const result = await this.rpcClient.callTool(input.actionName, input.args);
      const structured = asRecord(result.structuredContent);
      const textPayload = parseTextJson(result.text);
      const effectivePayload = structured ?? textPayload;

      if (result.isError) {
        return this.toToolError(input.actionName, effectivePayload, result.text);
      }

      if (effectivePayload) {
        const toolFailed = effectivePayload.ok === false;
        if (toolFailed) {
          return this.toToolError(input.actionName, effectivePayload, result.text);
        }
        return createSlackApiSuccess({
          data: effectivePayload,
        });
      }

      return createSlackApiSuccess({
        data: {},
      });
    } catch (error) {
      if (error instanceof SlackRpcClientError) {
        return createSlackApiError({
          code: normalizeErrorCode(error.code),
          message: error.message,
        });
      }
      return createSlackApiError({
        code: "integration_unavailable",
        message: `${input.actionName} failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private toToolError(
    actionName: string,
    payload: Record<string, unknown> | null,
    fallbackText: string | undefined
  ) {
    return createSlackApiError({
      code: normalizeErrorCode(payload?.code),
      message: asString(payload?.message) ?? asString(fallbackText) ?? `${actionName} failed`,
    });
  }
}
