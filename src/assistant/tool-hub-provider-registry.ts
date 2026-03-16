import { resolveMemorySearchRuntimeConfig } from "./memory/config.js";
import {
  executeMemoryGetRequest,
  executeMemorySearchRequest,
  validateMemoryGetRequest,
  validateMemorySearchRequest,
} from "./memory/tool-definitions.js";
import type { MemoryGetErrorPayload, MemorySearchErrorPayload } from "./memory/types.js";
import { appendDailyMemory, updateLongTermMemory } from "./memory/writer.js";
import {
  ProviderRegistry,
  type DynamicAction,
  type DynamicProvider,
} from "./dynamic-tool/index.js";
import {
  executePlaySlackSearchRequest,
  validatePlaySlackSearchRequest,
} from "./play-slack-search-tool.js";

export interface CreateAssistantProviderRegistryOptions {
  workspaceDir: string;
  projectRoot?: string;
  stateDir?: string;
  includeMemoryRead: boolean;
  includeMemoryWrite: boolean;
}

function readStringParam(
  params: Record<string, unknown>,
  key: string,
  required = false
): string | undefined {
  const value = params[key];
  if (typeof value !== "string") {
    if (required) {
      throw new Error(`${key} required`);
    }
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (required) {
      throw new Error(`${key} required`);
    }
    return undefined;
  }
  return trimmed;
}

function createActionMap(actions: DynamicAction[]): Map<string, DynamicAction> {
  return new Map(actions.map((action) => [action.descriptor.name, action]));
}

function createMemoryProvider(options: {
  workspaceDir: string;
  stateDir?: string;
  includeRead: boolean;
  includeWrite: boolean;
}): DynamicProvider | null {
  const actions: DynamicAction[] = [];
  const config = resolveMemorySearchRuntimeConfig({
    stateDir: options.stateDir,
    agentId: "main",
  });

  if (options.includeRead && config.enabled) {
    actions.push({
      descriptor: {
        name: "search",
        description:
          "Search MEMORY.md and memory/*.md, returning snippets with path and line range.",
        requiredArgs: ["query"],
        argsSchema: {
          type: "object",
          properties: {
            query: { type: "string", minLength: 1 },
            maxResults: { type: "number" },
            minScore: { type: "number" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      validate: (args) => {
        validateMemorySearchRequest(args);
      },
      execute: async (args) => {
        try {
          return await executeMemorySearchRequest(args, options.workspaceDir, config);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const payload: MemorySearchErrorPayload = {
            results: [],
            disabled: true,
            error: reason,
          };
          return payload;
        }
      },
    });
    actions.push({
      descriptor: {
        name: "get",
        description: "Read specific lines from MEMORY.md or memory/*.md after memory search.",
        requiredArgs: ["path"],
        argsSchema: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1 },
            from: { type: "number" },
            lines: { type: "number" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      validate: (args) => {
        validateMemoryGetRequest(args);
      },
      execute: async (args) => {
        const path = readStringParam(args, "path", true) ?? "";
        try {
          return await executeMemoryGetRequest(args, options.workspaceDir, config);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const payload: MemoryGetErrorPayload = {
            path,
            text: "",
            disabled: true,
            error: reason,
          };
          return payload;
        }
      },
    });
  }

  if (options.includeWrite) {
    actions.push({
      descriptor: {
        name: "write",
        description: "Persist notable context into assistant memory files.",
        requiredArgs: ["content"],
        argsSchema: {
          type: "object",
          properties: {
            content: { type: "string", minLength: 1 },
            scope: { enum: ["daily", "long-term"] },
          },
          required: ["content"],
          additionalProperties: false,
        },
      },
      validate: (args) => {
        readStringParam(args, "content", true);
        const scope = args.scope;
        if (scope !== undefined && scope !== "daily" && scope !== "long-term") {
          throw new Error("scope must be daily or long-term");
        }
      },
      execute: async (args) => {
        const content = readStringParam(args, "content", true) ?? "";
        const scope = args.scope === "long-term" ? "long-term" : "daily";
        const written =
          scope === "long-term"
            ? await updateLongTermMemory({ workspaceDir: options.workspaceDir, content })
            : await appendDailyMemory({ workspaceDir: options.workspaceDir, content });
        return {
          scope,
          path: written.path,
        };
      },
    });
  }

  if (actions.length === 0) {
    return null;
  }

  const actionMap = createActionMap(actions);
  return {
    name: "memory",
    description: "Read and write assistant memory files.",
    listActions: () => actions.map((action) => action.descriptor),
    getAction: (actionName) => actionMap.get(actionName),
  };
}

function createSlackProvider(options: { projectRoot: string }): DynamicProvider {
  const actions: DynamicAction[] = [
    {
      descriptor: {
        name: "search",
        description:
          "Search or resolve Slack message context via play-slack-search. For mode=search, pass Slack query syntax like from:me, from:@やまさき after:2026-03-03, or in:#channel. For mode=login, open a visible persistent Slack browser, return control immediately, and let the user log in manually. Supports thread, message, search, permalink, and login modes.",
        requiredArgs: ["mode"],
        argsSchema: {
          type: "object",
          properties: {
            mode: { enum: ["thread", "message", "search", "permalink", "login"] },
            channelId: { type: "string" },
            threadTs: { type: "string" },
            messageTs: { type: "string" },
            permalink: { type: "string" },
            workspaceUrl: { type: "string" },
            query: { type: "string" },
            limit: { type: "number" },
          },
          required: ["mode"],
          additionalProperties: false,
        },
      },
      validate: (args) => {
        validatePlaySlackSearchRequest(args);
      },
      execute: async (args) => {
        const request = validatePlaySlackSearchRequest(args);
        return await executePlaySlackSearchRequest(request, { cwd: options.projectRoot });
      },
    },
  ];
  const actionMap = createActionMap(actions);
  return {
    name: "slack",
    description:
      "Search Slack messages and resolve thread/message context. For your own posts use query=from:me.",
    listActions: () => actions.map((action) => action.descriptor),
    getAction: (actionName) => actionMap.get(actionName),
  };
}

export function createAssistantProviderRegistry(
  options: CreateAssistantProviderRegistryOptions
): ProviderRegistry {
  const providers: DynamicProvider[] = [
    createSlackProvider({ projectRoot: options.projectRoot ?? process.cwd() }),
  ];
  const memoryProvider = createMemoryProvider({
    workspaceDir: options.workspaceDir,
    stateDir: options.stateDir,
    includeRead: options.includeMemoryRead,
    includeWrite: options.includeMemoryWrite,
  });
  if (memoryProvider !== null) {
    providers.push(memoryProvider);
  }
  return new ProviderRegistry(providers);
}
