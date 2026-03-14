import { spawn } from "node:child_process";
import { join } from "node:path";

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

export type PlaySlackSearchMode = "thread" | "message" | "search" | "permalink";

export type PlaySlackSearchRequest = {
  mode: PlaySlackSearchMode;
  channelId?: string;
  threadTs?: string;
  messageTs?: string;
  permalink?: string;
  workspaceUrl?: string;
  query?: string;
  limit?: number;
};

export type PlaySlackSearchItem = {
  ts?: string;
  threadTs?: string;
  userId?: string;
  text: string;
  permalink?: string;
};

export type PlaySlackSearchResult = {
  mode: PlaySlackSearchMode;
  items: PlaySlackSearchItem[];
  warnings?: string[];
  sourceUrl?: string;
};

type ExecuteDeps = {
  cwd: string;
  timeoutMs?: number;
  runCommand?: (
    request: PlaySlackSearchRequest,
    options: { cwd: string; timeoutMs: number }
  ) => Promise<PlaySlackSearchResult>;
};

const PLAY_SLACK_SEARCH_TOOL_NAME = "play_slack_search";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const PLAY_SLACK_SEARCH_ADAPTER_ENTRY_ENV = "ADJUTANT_PLAY_SLACK_SEARCH_ADAPTER_ENTRY";

export function createPlaySlackSearchToolDefinition(
  cwd: string,
  deps: Omit<ExecuteDeps, "cwd"> = {}
): ToolDefinition {
  return {
    name: PLAY_SLACK_SEARCH_TOOL_NAME,
    label: PLAY_SLACK_SEARCH_TOOL_NAME,
    description:
      "Search or resolve Slack message context via play-slack-search. Supports thread, message, search, and permalink modes.",
    parameters: {
      type: "object",
      properties: {
        mode: {
          enum: ["thread", "message", "search", "permalink"],
        },
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
    } as never,
    execute: async (_toolCallId, rawParams) => {
      const request = validatePlaySlackSearchRequest(rawParams);
      const result = await executePlaySlackSearchRequest(request, {
        cwd,
        timeoutMs: deps.timeoutMs,
        runCommand: deps.runCommand,
      });
      return {
        content: [
          {
            type: "text",
            text: `play_slack_search completed (${result.mode}, ${result.items.length} items)`,
          },
        ],
        details: result,
      };
    },
  };
}

export function validatePlaySlackSearchRequest(rawParams: unknown): PlaySlackSearchRequest {
  const params = (rawParams ?? {}) as Record<string, unknown>;
  const mode = asMode(params.mode);
  if (mode === undefined) {
    throw new Error("mode must be one of thread|message|search|permalink");
  }
  const request: PlaySlackSearchRequest = {
    mode,
    channelId: asNonEmptyString(params.channelId),
    threadTs: asNonEmptyString(params.threadTs),
    messageTs: asNonEmptyString(params.messageTs),
    permalink: asNonEmptyString(params.permalink),
    workspaceUrl: asNonEmptyString(params.workspaceUrl),
    query: asNonEmptyString(params.query),
    limit: asPositiveInteger(params.limit),
  };

  if (mode === "search" && request.query === undefined) {
    throw new Error("query required for play_slack_search mode=search");
  }
  if (mode === "permalink" && request.permalink === undefined) {
    throw new Error("permalink required for play_slack_search mode=permalink");
  }
  if (mode === "message") {
    if (request.channelId === undefined || request.messageTs === undefined) {
      throw new Error("channelId and messageTs required for play_slack_search mode=message");
    }
  }
  if (mode === "thread") {
    if (request.permalink === undefined && request.channelId === undefined) {
      throw new Error(
        "channelId required for play_slack_search mode=thread unless permalink is provided"
      );
    }
    if (
      request.threadTs === undefined &&
      request.messageTs === undefined &&
      request.permalink === undefined
    ) {
      throw new Error(
        "threadTs, messageTs, or permalink required for play_slack_search mode=thread"
      );
    }
  }

  return request;
}

export async function executePlaySlackSearchRequest(
  request: PlaySlackSearchRequest,
  deps: ExecuteDeps
): Promise<PlaySlackSearchResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runCommand = deps.runCommand ?? runPlaySlackSearchAdapter;
  return await runCommand(request, { cwd: deps.cwd, timeoutMs });
}

async function runPlaySlackSearchAdapter(
  request: PlaySlackSearchRequest,
  options: { cwd: string; timeoutMs: number }
): Promise<PlaySlackSearchResult> {
  const scriptPath = resolveAdapterScriptPath(options.cwd);
  const child = spawn(process.execPath, ["--import", "tsx", scriptPath], {
    cwd: options.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let forced = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        forced = child.kill("SIGKILL");
      }
    }, DEFAULT_TERMINATION_GRACE_MS).unref();
  }, options.timeoutMs);

  return await new Promise<PlaySlackSearchResult>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `play_slack_search timeout after ${options.timeoutMs}ms${forced ? " (forced kill)" : ""}`
          )
        );
        return;
      }
      if (code !== 0) {
        reject(new Error(buildProcessFailureMessage(code, stderr, stdout)));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as unknown;
        resolve(validatePlaySlackSearchResult(parsed));
      } catch (error) {
        reject(
          new Error(
            `play_slack_search returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
          )
        );
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function resolveAdapterScriptPath(cwd: string): string {
  const fromEnv = process.env[PLAY_SLACK_SEARCH_ADAPTER_ENTRY_ENV]?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return join(cwd, "scripts", "play-slack-search-adapter.ts");
}

function validatePlaySlackSearchResult(value: unknown): PlaySlackSearchResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("play_slack_search result must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const mode = asMode(candidate.mode);
  if (mode === undefined) {
    throw new Error("play_slack_search result.mode invalid");
  }
  const itemsInput = Array.isArray(candidate.items) ? candidate.items : [];
  const items = itemsInput.map((item, index) => validatePlaySlackSearchItem(item, index));
  const warnings = Array.isArray(candidate.warnings)
    ? candidate.warnings.filter((item): item is string => typeof item === "string")
    : undefined;
  const sourceUrl = asNonEmptyString(candidate.sourceUrl);
  return {
    mode,
    items,
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

function validatePlaySlackSearchItem(value: unknown, index: number): PlaySlackSearchItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`play_slack_search result.items[${index}] must be an object`);
  }
  const candidate = value as Record<string, unknown>;
  const text = asNonEmptyString(candidate.text) ?? "";
  return {
    ...(asNonEmptyString(candidate.ts) ? { ts: asNonEmptyString(candidate.ts) } : {}),
    ...(asNonEmptyString(candidate.threadTs)
      ? { threadTs: asNonEmptyString(candidate.threadTs) }
      : {}),
    ...(asNonEmptyString(candidate.userId) ? { userId: asNonEmptyString(candidate.userId) } : {}),
    text,
    ...(asNonEmptyString(candidate.permalink)
      ? { permalink: asNonEmptyString(candidate.permalink) }
      : {}),
  };
}

function buildProcessFailureMessage(code: number | null, stderr: string, stdout: string): string {
  const stderrText = stderr.trim();
  const stdoutText = stdout.trim();
  const detail = stderrText || stdoutText;
  if (detail.length > 0) {
    return `play_slack_search exited with code ${code ?? "null"}: ${detail}`;
  }
  return `play_slack_search exited with code ${code ?? "null"}`;
}

function asMode(value: unknown): PlaySlackSearchMode | undefined {
  return value === "thread" || value === "message" || value === "search" || value === "permalink"
    ? value
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("limit must be a positive integer");
  }
  const normalized = Math.floor(value);
  if (normalized < 1) {
    throw new Error("limit must be a positive integer");
  }
  return normalized;
}

export { PLAY_SLACK_SEARCH_TOOL_NAME, DEFAULT_TIMEOUT_MS, PLAY_SLACK_SEARCH_ADAPTER_ENTRY_ENV };
