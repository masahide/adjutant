import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

import { jsonToolResult } from "./json-tool-result.js";
import { getOrCreateMemorySqliteIndex } from "./sqlite-index.js";
import type {
  MemoryGetErrorPayload,
  MemorySearchErrorPayload,
  MemorySearchRuntimeConfig,
} from "./types.js";

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

function readNumberParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export function validateMemorySearchRequest(rawParams: unknown): {
  query: string;
  maxResults?: number;
  minScore?: number;
} {
  const params = (rawParams ?? {}) as Record<string, unknown>;
  return {
    query: readStringParam(params, "query", true) ?? "",
    maxResults: readNumberParam(params, "maxResults"),
    minScore: readNumberParam(params, "minScore"),
  };
}

export async function executeMemorySearchRequest(
  rawParams: unknown,
  workspaceDir: string,
  config: MemorySearchRuntimeConfig
): Promise<unknown> {
  const params = validateMemorySearchRequest(rawParams);
  const manager = getOrCreateMemorySqliteIndex({
    workspaceDir,
    config,
  });
  return await manager.search(params.query, {
    maxResults: params.maxResults,
    minScore: params.minScore,
  });
}

export function validateMemoryGetRequest(rawParams: unknown): {
  path: string;
  from?: number;
  lines?: number;
} {
  const params = (rawParams ?? {}) as Record<string, unknown>;
  return {
    path: readStringParam(params, "path", true) ?? "",
    from: readNumberParam(params, "from"),
    lines: readNumberParam(params, "lines"),
  };
}

export async function executeMemoryGetRequest(
  rawParams: unknown,
  workspaceDir: string,
  config: MemorySearchRuntimeConfig
): Promise<unknown> {
  const params = validateMemoryGetRequest(rawParams);
  const manager = getOrCreateMemorySqliteIndex({
    workspaceDir,
    config,
  });
  return await manager.readFile({
    relPath: params.path,
    from: params.from !== undefined ? Math.floor(params.from) : undefined,
    lines: params.lines !== undefined ? Math.floor(params.lines) : undefined,
  });
}

export function createMemoryToolDefinitions(params: {
  workspaceDir: string;
  config: MemorySearchRuntimeConfig;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
}): ToolDefinition[] {
  if (!params.config.enabled) {
    return [];
  }

  const memorySearchTool: ToolDefinition = {
    name: "memory_search",
    label: "Memory Search",
    description: "Search MEMORY.md and memory/*.md, returning snippets with path and line range.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        maxResults: { type: "number" },
        minScore: { type: "number" },
      },
      required: ["query"],
      additionalProperties: false,
    } as never,
    execute: async (_toolCallId, rawParams) => {
      try {
        const result = await executeMemorySearchRequest(
          rawParams,
          params.workspaceDir,
          params.config
        );
        return jsonToolResult(result);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        params.onWarn?.("memory_search failed", { reason });
        const payload: MemorySearchErrorPayload = {
          results: [],
          disabled: true,
          error: reason,
        };
        return jsonToolResult(payload);
      }
    },
  };

  const memoryGetTool: ToolDefinition = {
    name: "memory_get",
    label: "Memory Get",
    description: "Read specific lines from MEMORY.md or memory/*.md after memory_search.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        from: { type: "number" },
        lines: { type: "number" },
      },
      required: ["path"],
      additionalProperties: false,
    } as never,
    execute: async (_toolCallId, rawParams) => {
      const path =
        readStringParam((rawParams ?? {}) as Record<string, unknown>, "path", true) ?? "";
      try {
        const result = await executeMemoryGetRequest(rawParams, params.workspaceDir, params.config);
        return jsonToolResult(result);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        params.onWarn?.("memory_get failed", { reason, path });
        const payload: MemoryGetErrorPayload = {
          path,
          text: "",
          disabled: true,
          error: reason,
        };
        return jsonToolResult(payload);
      }
    },
  };

  return [memorySearchTool, memoryGetTool];
}
