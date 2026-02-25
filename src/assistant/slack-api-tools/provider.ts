import type { DynamicAction, DynamicProvider } from "../dynamic-tool/index.js";
import { isSlackRoutingMode, type SlackRoutingMode } from "./types.js";
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

function readOptionalPositiveInt(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number`);
  }
  return Math.floor(value);
}

function validateRoutingMode(args: Record<string, unknown>): SlackRoutingMode | undefined {
  const routingMode = readString(args, "routing_mode");
  if (!routingMode) {
    return undefined;
  }
  if (!isSlackRoutingMode(routingMode)) {
    throw new Error("routing_mode must be manual_team/manual_enterprise/auto_probe");
  }
  return routingMode;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = readString(args, key);
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function baseProperties() {
  return {
    routing_mode: {
      type: "string",
      enum: ["manual_team", "manual_enterprise", "auto_probe"],
    },
    workspace_key: { type: "string", minLength: 1 },
  };
}

export function createSlackDynamicProvider(service: SlackApiService): DynamicProvider {
  const actions = new Map<string, DynamicAction>();

  const getUserNameByIdAction: DynamicAction = {
    descriptor: {
      name: "get_user_name_by_id",
      description: "Resolve Slack user name from user_id",
      requiredArgs: ["user_id"],
      argsSchema: {
        type: "object",
        properties: {
          ...baseProperties(),
          user_id: { type: "string", minLength: 1 },
          team_id: { type: "string", minLength: 1 },
          channel_id: { type: "string", minLength: 1 },
        },
        required: ["user_id"],
        additionalProperties: false,
      },
    },
    validate: (rawArgs) => {
      const args = asRecord(rawArgs);
      requireString(args, "user_id");
      validateRoutingMode(args);
    },
    execute: async (rawArgs) => {
      return await service.getUserNameById(asRecord(rawArgs));
    },
  };

  const getChannelNameByIdAction: DynamicAction = {
    descriptor: {
      name: "get_channel_name_by_id",
      description: "Resolve Slack channel name from channel_id",
      requiredArgs: ["channel_id"],
      argsSchema: {
        type: "object",
        properties: {
          ...baseProperties(),
          channel_id: { type: "string", minLength: 1 },
          team_id: { type: "string", minLength: 1 },
        },
        required: ["channel_id"],
        additionalProperties: false,
      },
    },
    validate: (rawArgs) => {
      const args = asRecord(rawArgs);
      requireString(args, "channel_id");
      validateRoutingMode(args);
    },
    execute: async (rawArgs) => {
      return await service.getChannelNameById(asRecord(rawArgs));
    },
  };

  const usersListAction: DynamicAction = {
    descriptor: {
      name: "users_list",
      description: "List users and update shared Slack name cache",
      argsSchema: {
        type: "object",
        properties: {
          ...baseProperties(),
        },
        additionalProperties: false,
      },
    },
    validate: (rawArgs) => {
      const args = asRecord(rawArgs);
      validateRoutingMode(args);
    },
    execute: async (rawArgs) => {
      return await service.listUsers(asRecord(rawArgs));
    },
  };

  const workspacesListAction: DynamicAction = {
    descriptor: {
      name: "workspaces_list",
      description: "List cached Slack workspaces resolved from xoxc/xoxd registry",
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

  const channelsListAction: DynamicAction = {
    descriptor: {
      name: "channels_list",
      description: "List channels and update shared Slack name cache",
      argsSchema: {
        type: "object",
        properties: {
          ...baseProperties(),
        },
        additionalProperties: false,
      },
    },
    validate: (rawArgs) => {
      const args = asRecord(rawArgs);
      validateRoutingMode(args);
    },
    execute: async (rawArgs) => {
      return await service.listChannels(asRecord(rawArgs));
    },
  };

  const searchMessagesAction: DynamicAction = {
    descriptor: {
      name: "search_messages",
      description: "Search Slack messages with optional auto fallback",
      requiredArgs: ["query"],
      argsSchema: {
        type: "object",
        properties: {
          ...baseProperties(),
          query: { type: "string", minLength: 1 },
          limit: { type: "number", minimum: 1 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    validate: (rawArgs) => {
      const args = asRecord(rawArgs);
      requireString(args, "query");
      readOptionalPositiveInt(args, "limit");
      validateRoutingMode(args);
    },
    execute: async (rawArgs) => {
      return await service.searchMessages(asRecord(rawArgs));
    },
  };

  const postMessageAction: DynamicAction = {
    descriptor: {
      name: "post_message",
      description: "Post a Slack message with selectable routing mode",
      requiredArgs: ["channel_id", "text"],
      argsSchema: {
        type: "object",
        properties: {
          ...baseProperties(),
          channel_id: { type: "string", minLength: 1 },
          text: { type: "string", minLength: 1 },
        },
        required: ["channel_id", "text"],
        additionalProperties: false,
      },
    },
    validate: (rawArgs) => {
      const args = asRecord(rawArgs);
      requireString(args, "channel_id");
      requireString(args, "text");
      validateRoutingMode(args);
    },
    execute: async (rawArgs) => {
      return await service.postMessage(asRecord(rawArgs));
    },
  };

  actions.set(getUserNameByIdAction.descriptor.name, getUserNameByIdAction);
  actions.set(getChannelNameByIdAction.descriptor.name, getChannelNameByIdAction);
  actions.set(workspacesListAction.descriptor.name, workspacesListAction);
  actions.set(usersListAction.descriptor.name, usersListAction);
  actions.set(channelsListAction.descriptor.name, channelsListAction);
  actions.set(searchMessagesAction.descriptor.name, searchMessagesAction);
  actions.set(postMessageAction.descriptor.name, postMessageAction);

  return {
    name: "slack",
    description: "Slack API tools with team/enterprise routing",
    listActions: () => [...actions.values()].map((action) => action.descriptor),
    getAction: (actionName) => actions.get(actionName.trim().toLowerCase()),
  };
}
