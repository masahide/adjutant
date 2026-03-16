import { spawn } from "node:child_process";
import { join } from "node:path";

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

export type PlaySlackSearchMode = "thread" | "message" | "search" | "permalink" | "login";

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
  instructions?: string;
  warnings?: string[];
  sourceUrl?: string;
};

export type PlaySlackSearchListUsersRequest = {
  mode: "list-users";
  workspaceUrl?: string;
  limit?: number;
  hydrate?: boolean;
};

export type PlaySlackSearchUser = {
  id?: string;
  teamId?: string;
  name?: string;
  realName?: string;
  displayName?: string;
  displayNameNormalized?: string;
  title?: string;
  email?: string;
  tz?: string;
  updated?: number;
  isAdmin?: boolean;
  isAppUser?: boolean;
  isBot?: boolean;
  isDeleted?: boolean;
  isOwner?: boolean;
  isPrimaryOwner?: boolean;
  isRestricted?: boolean;
  isStranger?: boolean;
  isUltraRestricted?: boolean;
};

export type PlaySlackSearchListUsersResult = {
  mode: "list-users";
  users: PlaySlackSearchUser[];
  sourceUrl?: string;
  source?: string;
  stateKey?: string;
  totalUserCount?: number;
};

export type PlaySlackSearchResolveChannelRequest = {
  mode: "resolve-channel-id";
  workspaceUrl?: string;
  channelIds: string[];
};

export type PlaySlackSearchResolvedChannel = {
  channelId: string;
  channelName?: string;
  resolved: boolean;
  source?: string;
  stateKey?: string;
};

export type PlaySlackSearchResolveChannelResult = {
  mode: "resolve-channel-id";
  channels: PlaySlackSearchResolvedChannel[];
  sourceUrl?: string;
};

export type PlaySlackSearchAdapterRequest =
  | PlaySlackSearchRequest
  | PlaySlackSearchListUsersRequest
  | PlaySlackSearchResolveChannelRequest;

export type PlaySlackSearchAdapterResult =
  | PlaySlackSearchResult
  | PlaySlackSearchListUsersResult
  | PlaySlackSearchResolveChannelResult;

type ExecuteDeps<TRequest, TResult> = {
  cwd: string;
  timeoutMs?: number;
  runCommand?: (request: TRequest, options: { cwd: string; timeoutMs: number }) => Promise<TResult>;
};

const PLAY_SLACK_SEARCH_TOOL_NAME = "play_slack_search";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const PLAY_SLACK_SEARCH_ADAPTER_ENTRY_ENV = "ADJUTANT_PLAY_SLACK_SEARCH_ADAPTER_ENTRY";

export function createPlaySlackSearchToolDefinition(
  cwd: string,
  deps: Omit<ExecuteDeps<PlaySlackSearchRequest, PlaySlackSearchResult>, "cwd"> = {}
): ToolDefinition {
  return {
    name: PLAY_SLACK_SEARCH_TOOL_NAME,
    label: PLAY_SLACK_SEARCH_TOOL_NAME,
    description:
      "Search or resolve Slack message context via play-slack-search. Use mode=search with Slack query syntax such as from:me, from:@やまさき after:2026-03-03, or in:#channel. Use mode=login to open a visible persistent Slack browser, return control immediately, and let the user log in manually. Supports thread, message, search, permalink, and login modes.",
    parameters: {
      type: "object",
      properties: {
        mode: {
          enum: ["thread", "message", "search", "permalink", "login"],
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
    throw new Error("mode must be one of thread|message|search|permalink|login");
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
  if (mode === "login") {
    return request;
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

export function validatePlaySlackSearchListUsersRequest(
  rawParams: unknown
): PlaySlackSearchListUsersRequest {
  const params = (rawParams ?? {}) as Record<string, unknown>;
  return {
    mode: "list-users",
    workspaceUrl: asNonEmptyString(params.workspaceUrl),
    limit: asPositiveInteger(params.limit),
    hydrate: asBoolean(params.hydrate, "hydrate"),
  };
}

export function validatePlaySlackSearchResolveChannelRequest(
  rawParams: unknown
): PlaySlackSearchResolveChannelRequest {
  const params = (rawParams ?? {}) as Record<string, unknown>;
  return {
    mode: "resolve-channel-id",
    workspaceUrl: asNonEmptyString(params.workspaceUrl),
    channelIds: asNonEmptyStringArray(params.channelIds, "channelIds"),
  };
}

async function executeTypedPlaySlackSearchRequest<TRequest, TResult>(
  request: TRequest,
  deps: ExecuteDeps<TRequest, TResult>,
  validateResult: (value: unknown) => TResult
): Promise<TResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runCommand =
    deps.runCommand ??
    (async (rawRequest: TRequest, options: { cwd: string; timeoutMs: number }) =>
      validateResult(
        await runPlaySlackSearchAdapterRaw(rawRequest as PlaySlackSearchAdapterRequest, options)
      ));
  return await runCommand(request, { cwd: deps.cwd, timeoutMs });
}

export async function executePlaySlackSearchRequest(
  request: PlaySlackSearchRequest,
  deps: ExecuteDeps<PlaySlackSearchRequest, PlaySlackSearchResult>
): Promise<PlaySlackSearchResult> {
  return await executeTypedPlaySlackSearchRequest(request, deps, validatePlaySlackSearchResult);
}

export async function executePlaySlackSearchListUsersRequest(
  request: PlaySlackSearchListUsersRequest,
  deps: ExecuteDeps<PlaySlackSearchListUsersRequest, PlaySlackSearchListUsersResult>
): Promise<PlaySlackSearchListUsersResult> {
  return await executeTypedPlaySlackSearchRequest(
    request,
    deps,
    validatePlaySlackSearchListUsersResult
  );
}

export async function executePlaySlackSearchResolveChannelRequest(
  request: PlaySlackSearchResolveChannelRequest,
  deps: ExecuteDeps<PlaySlackSearchResolveChannelRequest, PlaySlackSearchResolveChannelResult>
): Promise<PlaySlackSearchResolveChannelResult> {
  return await executeTypedPlaySlackSearchRequest(
    request,
    deps,
    validatePlaySlackSearchResolveChannelResult
  );
}

async function runPlaySlackSearchAdapterRaw(
  request: PlaySlackSearchAdapterRequest,
  options: { cwd: string; timeoutMs: number }
): Promise<unknown> {
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

  return await new Promise<unknown>((resolve, reject) => {
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
        resolve(parsed);
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
  const instructions = asNonEmptyString(candidate.instructions);
  const sourceUrl = asNonEmptyString(candidate.sourceUrl);
  return {
    mode,
    items,
    ...(instructions ? { instructions } : {}),
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

function validatePlaySlackSearchListUsersResult(value: unknown): PlaySlackSearchListUsersResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("play_slack_search list-users result must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.mode !== "list-users") {
    throw new Error("play_slack_search list-users result.mode invalid");
  }
  const usersInput = Array.isArray(candidate.users) ? candidate.users : [];
  const users = usersInput.map((user, index) => validatePlaySlackSearchUser(user, index));
  return {
    mode: "list-users",
    users,
    ...(asNonEmptyString(candidate.sourceUrl)
      ? { sourceUrl: asNonEmptyString(candidate.sourceUrl) }
      : {}),
    ...(asNonEmptyString(candidate.source) ? { source: asNonEmptyString(candidate.source) } : {}),
    ...(asNonEmptyString(candidate.stateKey)
      ? { stateKey: asNonEmptyString(candidate.stateKey) }
      : {}),
    ...(typeof candidate.totalUserCount === "number" && Number.isFinite(candidate.totalUserCount)
      ? { totalUserCount: candidate.totalUserCount }
      : {}),
  };
}

function validatePlaySlackSearchUser(value: unknown, index: number): PlaySlackSearchUser {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`play_slack_search list-users result.users[${index}] must be an object`);
  }
  const candidate = value as Record<string, unknown>;
  return {
    ...(asNonEmptyString(candidate.id) ? { id: asNonEmptyString(candidate.id) } : {}),
    ...(asNonEmptyString(candidate.teamId) ? { teamId: asNonEmptyString(candidate.teamId) } : {}),
    ...(asNonEmptyString(candidate.name) ? { name: asNonEmptyString(candidate.name) } : {}),
    ...(asNonEmptyString(candidate.realName)
      ? { realName: asNonEmptyString(candidate.realName) }
      : {}),
    ...(asNonEmptyString(candidate.displayName)
      ? { displayName: asNonEmptyString(candidate.displayName) }
      : {}),
    ...(asNonEmptyString(candidate.displayNameNormalized)
      ? { displayNameNormalized: asNonEmptyString(candidate.displayNameNormalized) }
      : {}),
    ...(asNonEmptyString(candidate.title) ? { title: asNonEmptyString(candidate.title) } : {}),
    ...(asNonEmptyString(candidate.email) ? { email: asNonEmptyString(candidate.email) } : {}),
    ...(asNonEmptyString(candidate.tz) ? { tz: asNonEmptyString(candidate.tz) } : {}),
    ...(typeof candidate.updated === "number" && Number.isFinite(candidate.updated)
      ? { updated: candidate.updated }
      : {}),
    ...(typeof candidate.isAdmin === "boolean" ? { isAdmin: candidate.isAdmin } : {}),
    ...(typeof candidate.isAppUser === "boolean" ? { isAppUser: candidate.isAppUser } : {}),
    ...(typeof candidate.isBot === "boolean" ? { isBot: candidate.isBot } : {}),
    ...(typeof candidate.isDeleted === "boolean" ? { isDeleted: candidate.isDeleted } : {}),
    ...(typeof candidate.isOwner === "boolean" ? { isOwner: candidate.isOwner } : {}),
    ...(typeof candidate.isPrimaryOwner === "boolean"
      ? { isPrimaryOwner: candidate.isPrimaryOwner }
      : {}),
    ...(typeof candidate.isRestricted === "boolean"
      ? { isRestricted: candidate.isRestricted }
      : {}),
    ...(typeof candidate.isStranger === "boolean" ? { isStranger: candidate.isStranger } : {}),
    ...(typeof candidate.isUltraRestricted === "boolean"
      ? { isUltraRestricted: candidate.isUltraRestricted }
      : {}),
  };
}

function validatePlaySlackSearchResolveChannelResult(
  value: unknown
): PlaySlackSearchResolveChannelResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("play_slack_search resolve-channel-id result must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.mode !== "resolve-channel-id") {
    throw new Error("play_slack_search resolve-channel-id result.mode invalid");
  }
  const channelsInput = Array.isArray(candidate.channels) ? candidate.channels : [];
  const channels = channelsInput.map((channel, index) =>
    validatePlaySlackSearchResolvedChannel(channel, index)
  );
  return {
    mode: "resolve-channel-id",
    channels,
    ...(asNonEmptyString(candidate.sourceUrl)
      ? { sourceUrl: asNonEmptyString(candidate.sourceUrl) }
      : {}),
  };
}

function validatePlaySlackSearchResolvedChannel(
  value: unknown,
  index: number
): PlaySlackSearchResolvedChannel {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `play_slack_search resolve-channel-id result.channels[${index}] must be an object`
    );
  }
  const candidate = value as Record<string, unknown>;
  const channelId = asNonEmptyString(candidate.channelId);
  if (channelId === undefined) {
    throw new Error(
      `play_slack_search resolve-channel-id result.channels[${index}].channelId required`
    );
  }
  if (typeof candidate.resolved !== "boolean") {
    throw new Error(
      `play_slack_search resolve-channel-id result.channels[${index}].resolved required`
    );
  }
  return {
    channelId,
    resolved: candidate.resolved,
    ...(asNonEmptyString(candidate.channelName)
      ? { channelName: asNonEmptyString(candidate.channelName) }
      : {}),
    ...(asNonEmptyString(candidate.source) ? { source: asNonEmptyString(candidate.source) } : {}),
    ...(asNonEmptyString(candidate.stateKey)
      ? { stateKey: asNonEmptyString(candidate.stateKey) }
      : {}),
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
  return value === "thread" ||
    value === "message" ||
    value === "search" ||
    value === "permalink" ||
    value === "login"
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

function asNonEmptyStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be a non-empty string array`);
  }
  const items = value
    .map((item) => asNonEmptyString(item))
    .filter((item): item is string => item !== undefined);
  if (items.length === 0) {
    throw new Error(`${key} must be a non-empty string array`);
  }
  return items;
}

function asBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
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
