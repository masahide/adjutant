import type { DynamicAction, DynamicProvider } from "../dynamic-tool/index.js";
import type { SlackApiService } from "./service.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = readString(args, key);
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function validatePositiveInt(args: Record<string, unknown>, key: string): void {
  const value = args[key];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number`);
  }
}

function requireWorkspaceKey(args: Record<string, unknown>): void {
  requireString(args, "workspace_key");
}

function baseProperties() {
  return {
    workspace_key: { type: "string", minLength: 1 },
  };
}

export function createSlackDynamicProvider(service: SlackApiService): DynamicProvider {
  const actions = new Map<string, DynamicAction>();

  const workspacesListAction: DynamicAction = {
    descriptor: {
      name: "workspaces_list",
      description: "List currently registered Slack workspaces from RPC gateway",
      argsSchema: {
        type: "object",
        properties: {
          account_id: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    },
    validate: (rawArgs) => {
      const args = asRecord(rawArgs);
      if (
        Object.prototype.hasOwnProperty.call(args, "account_id") &&
        !readString(args, "account_id")
      ) {
        throw new Error("account_id must be a non-empty string");
      }
    },
    execute: async (rawArgs) => {
      return await service.listWorkspaces(asRecord(rawArgs));
    },
  };

  const workspaceRegisterAction: DynamicAction = {
    descriptor: {
      name: "workspace_register",
      description: "Register Slack workspace runtime in gateway",
      requiredArgs: ["xoxc", "xoxd"],
      argsSchema: {
        type: "object",
        properties: {
          ...baseProperties(),
          xoxc: { type: "string", minLength: 1 },
          xoxd: { type: "string", minLength: 1 },
          cache_dir: { type: "string", minLength: 1 },
        },
        required: ["xoxc", "xoxd"],
        additionalProperties: false,
      },
    },
    validate: (rawArgs) => {
      const args = asRecord(rawArgs);
      if (
        Object.prototype.hasOwnProperty.call(args, "workspace_key") &&
        !readString(args, "workspace_key")
      ) {
        throw new Error("workspace_key must be a non-empty string");
      }
      requireString(args, "xoxc");
      requireString(args, "xoxd");
    },
    execute: async (rawArgs) => {
      return await service.workspaceRegister(asRecord(rawArgs));
    },
  };

  const workspaceUnregisterAction: DynamicAction = {
    descriptor: {
      name: "workspace_unregister",
      description: "Unregister Slack workspace runtime from gateway",
      requiredArgs: ["workspace_key"],
      argsSchema: {
        type: "object",
        properties: {
          ...baseProperties(),
        },
        required: ["workspace_key"],
        additionalProperties: false,
      },
    },
    validate: (rawArgs) => {
      requireWorkspaceKey(asRecord(rawArgs));
    },
    execute: async (rawArgs) => {
      return await service.workspaceUnregister(asRecord(rawArgs));
    },
  };

  const usersListAction: DynamicAction = {
    descriptor: {
      name: "users_list",
      description: "List users from selected workspace",
      requiredArgs: ["workspace_key"],
      argsSchema: {
        type: "object",
        properties: {
          ...baseProperties(),
          limit: { type: "number", minimum: 1 },
        },
        required: ["workspace_key"],
        additionalProperties: false,
      },
    },
    validate: (rawArgs) => {
      const args = asRecord(rawArgs);
      requireWorkspaceKey(args);
      validatePositiveInt(args, "limit");
    },
    execute: async (rawArgs) => {
      return await service.listUsers(asRecord(rawArgs));
    },
  };

  const channelsListAction: DynamicAction = {
    descriptor: {
      name: "channels_list",
      description: "List channels from selected workspace",
      requiredArgs: ["workspace_key"],
      argsSchema: {
        type: "object",
        properties: {
          ...baseProperties(),
          sort: { type: "string", minLength: 1 },
          channel_types: { type: "string", minLength: 1 },
          cursor: { type: "string" },
          limit: { type: "number", minimum: 1 },
        },
        required: ["workspace_key"],
        additionalProperties: false,
      },
    },
    validate: (rawArgs) => {
      const args = asRecord(rawArgs);
      requireWorkspaceKey(args);
      validatePositiveInt(args, "limit");
    },
    execute: async (rawArgs) => {
      return await service.listChannels(asRecord(rawArgs));
    },
  };

  const getUserInfoAction: DynamicAction = {
    descriptor: {
      name: "get_user_info",
      description: "Get Slack user information by user_id",
      requiredArgs: ["workspace_key", "user_id"],
      argsSchema: {
        type: "object",
        properties: {
          ...baseProperties(),
          user_id: { type: "string", minLength: 1 },
        },
        required: ["workspace_key", "user_id"],
        additionalProperties: false,
      },
    },
    validate: (rawArgs) => {
      const args = asRecord(rawArgs);
      requireWorkspaceKey(args);
      requireString(args, "user_id");
    },
    execute: async (rawArgs) => {
      return await service.getUserInfo(asRecord(rawArgs));
    },
  };

  const getChannelInfoAction: DynamicAction = {
    descriptor: {
      name: "get_channel_info",
      description: "Get Slack channel information by channel_id",
      requiredArgs: ["workspace_key", "channel_id"],
      argsSchema: {
        type: "object",
        properties: {
          ...baseProperties(),
          channel_id: { type: "string", minLength: 1 },
        },
        required: ["workspace_key", "channel_id"],
        additionalProperties: false,
      },
    },
    validate: (rawArgs) => {
      const args = asRecord(rawArgs);
      requireWorkspaceKey(args);
      requireString(args, "channel_id");
    },
    execute: async (rawArgs) => {
      return await service.getChannelInfo(asRecord(rawArgs));
    },
  };

  const getUserNameByIdAction: DynamicAction = {
    descriptor: {
      name: "get_user_name_by_id",
      description: "Resolve Slack user name by user_id",
      requiredArgs: ["workspace_key", "user_id"],
      argsSchema: {
        type: "object",
        properties: {
          ...baseProperties(),
          user_id: { type: "string", minLength: 1 },
          team_id: { type: "string", minLength: 1 },
          channel_id: { type: "string", minLength: 1 },
          routing_mode: { type: "string", minLength: 1 },
        },
        required: ["workspace_key", "user_id"],
        additionalProperties: false,
      },
    },
    validate: (rawArgs) => {
      const args = asRecord(rawArgs);
      requireWorkspaceKey(args);
      requireString(args, "user_id");
    },
    execute: async (rawArgs) => {
      return await service.getUserNameById(asRecord(rawArgs));
    },
  };

  const getChannelNameByIdAction: DynamicAction = {
    descriptor: {
      name: "get_channel_name_by_id",
      description: "Resolve Slack channel name by channel_id",
      requiredArgs: ["workspace_key", "channel_id"],
      argsSchema: {
        type: "object",
        properties: {
          ...baseProperties(),
          channel_id: { type: "string", minLength: 1 },
          team_id: { type: "string", minLength: 1 },
          routing_mode: { type: "string", minLength: 1 },
        },
        required: ["workspace_key", "channel_id"],
        additionalProperties: false,
      },
    },
    validate: (rawArgs) => {
      const args = asRecord(rawArgs);
      requireWorkspaceKey(args);
      requireString(args, "channel_id");
    },
    execute: async (rawArgs) => {
      return await service.getChannelNameById(asRecord(rawArgs));
    },
  };

  const searchMessagesAction: DynamicAction = {
    descriptor: {
      name: "search_messages",
      description: "Search messages in selected Slack workspace",
      requiredArgs: ["workspace_key"],
      argsSchema: {
        type: "object",
        properties: {
          ...baseProperties(),
          query: { type: "string", minLength: 1 },
          search_query: { type: "string", minLength: 1 },
          limit: { type: "number", minimum: 1 },
          cursor: { type: "string" },
          filter_in_channel: { type: "string", minLength: 1 },
          filter_in_im_or_mpim: { type: "string", minLength: 1 },
          filter_users_with: { type: "string", minLength: 1 },
          filter_users_from: { type: "string", minLength: 1 },
          filter_date_before: { type: "string", minLength: 1 },
          filter_date_after: { type: "string", minLength: 1 },
          filter_date_on: { type: "string", minLength: 1 },
          filter_date_during: { type: "string", minLength: 1 },
        },
        required: ["workspace_key"],
        additionalProperties: false,
      },
    },
    validate: (rawArgs) => {
      const args = asRecord(rawArgs);
      requireWorkspaceKey(args);
      validatePositiveInt(args, "limit");
      const query = readString(args, "query");
      const searchQuery = readString(args, "search_query");
      if (!query && !searchQuery) {
        throw new Error("query or search_query is required");
      }
    },
    execute: async (rawArgs) => {
      return await service.searchMessages(asRecord(rawArgs));
    },
  };

  const postMessageAction: DynamicAction = {
    descriptor: {
      name: "post_message",
      description: "Post message to Slack channel",
      requiredArgs: ["workspace_key", "channel_id", "text"],
      argsSchema: {
        type: "object",
        properties: {
          ...baseProperties(),
          channel_id: { type: "string", minLength: 1 },
          text: { type: "string", minLength: 1 },
          thread_ts: { type: "string", minLength: 1 },
          content_type: { type: "string", minLength: 1 },
        },
        required: ["workspace_key", "channel_id", "text"],
        additionalProperties: false,
      },
    },
    validate: (rawArgs) => {
      const args = asRecord(rawArgs);
      requireWorkspaceKey(args);
      requireString(args, "channel_id");
      requireString(args, "text");
    },
    execute: async (rawArgs) => {
      return await service.postMessage(asRecord(rawArgs));
    },
  };

  const authTestAction: DynamicAction = {
    descriptor: {
      name: "auth_test",
      description: "Get auth.test style identity for selected workspace",
      requiredArgs: ["workspace_key"],
      argsSchema: {
        type: "object",
        properties: {
          ...baseProperties(),
        },
        required: ["workspace_key"],
        additionalProperties: false,
      },
    },
    validate: (rawArgs) => {
      requireWorkspaceKey(asRecord(rawArgs));
    },
    execute: async (rawArgs) => {
      return await service.authTest(asRecord(rawArgs));
    },
  };

  for (const action of [
    workspacesListAction,
    workspaceRegisterAction,
    workspaceUnregisterAction,
    usersListAction,
    channelsListAction,
    getUserInfoAction,
    getChannelInfoAction,
    getUserNameByIdAction,
    getChannelNameByIdAction,
    searchMessagesAction,
    postMessageAction,
    authTestAction,
  ]) {
    actions.set(action.descriptor.name, action);
  }

  return {
    name: "slack",
    description: "Slack RPC Gateway tools",
    listActions: () => [...actions.values()].map((action) => action.descriptor),
    getAction: (actionName) => actions.get(actionName.trim().toLowerCase()),
  };
}
