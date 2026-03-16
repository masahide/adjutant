#!/usr/bin/env -S node --import tsx

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import process from "node:process";

import {
  type PlaySlackSearchAdapterRequest,
  type PlaySlackSearchAdapterResult,
  type PlaySlackSearchItem,
  type PlaySlackSearchListUsersResult,
  type PlaySlackSearchRequest,
  type PlaySlackSearchResult,
  type PlaySlackSearchResolveChannelResult,
} from "../src/assistant/play-slack-search-tool.js";
import { deriveSlackPermalink } from "../src/collector-slack/notification-derived-fields.js";
import { loadProjectEnv } from "../src/runtime/load-project-env.js";

import {
  type DefaultSessionExport,
  type ExecuteSlackCommandExport,
  type LoadPackageEnvExport,
  type NormalizeProfilePathExport,
  type PlaywrightCliExport,
  type PrepareSessionExport,
  type RunInteractiveLoginExport,
  type SafeCloseSessionExport,
} from "./play-slack-search-adapter.types.js";

const require = createRequire(import.meta.url);
const { executeSlackCommand } =
  require("../play-slack-search/scripts/slack-search/command.ts") as ExecuteSlackCommandExport;
const { loadPackageEnv, PLAY_SLACK_SEARCH_WORKSPACE_URL_ENV } =
  require("../play-slack-search/scripts/slack-search/env.ts") as LoadPackageEnvExport;
const { normalizeProfilePath, defaultProfilePath } =
  require("../play-slack-search/scripts/slack-search/profile.ts") as NormalizeProfilePathExport;
const { runJson, serializeBrowserCode } =
  require("../play-slack-search/scripts/slack-search/playwright-cli.ts") as PlaywrightCliExport;
const { prepareSession, safeCloseSession } =
  require("../play-slack-search/scripts/slack-search/session.ts") as PrepareSessionExport &
    SafeCloseSessionExport;
const { runInteractiveLogin } =
  require("../play-slack-search/scripts/slack-search/session.ts") as RunInteractiveLoginExport;
const { DEFAULT_SESSION } =
  require("../play-slack-search/scripts/slack-search/contracts.ts") as DefaultSessionExport;

loadProjectEnv();

interface PermalinkCodeInput {
  limit: number;
  permalink: string;
}

interface PermalinkPayload {
  items: Array<{
    messageUrl: string | null;
    sender: string | null;
    slackTs: string | null;
    text: string | null;
  }>;
  mode: "permalink";
  pageTitle: string;
  pageUrl: string;
}

type SearchPayloadLike = {
  results: Array<{
    messageUrl?: string;
    slackTs?: string;
    text?: string;
  }>;
  searchUrl?: string;
  noResults?: boolean;
};

type UserListPayloadLike = {
  listUrl?: string;
  source?: string;
  stateKey?: string | null;
  totalUserCount?: number;
  users: Array<Record<string, unknown>>;
};

type ResolveChannelsPayloadLike = {
  channels: Array<{
    channelId?: string;
    channelName?: string | null;
    resolved?: boolean;
    source?: string;
    stateKey?: string | null;
  }>;
  listUrl?: string;
};

type AdapterDeps = {
  executeSlackCommand: typeof executeSlackCommand;
  runPermalinkPayload: typeof runPermalinkPayload;
};

type BrowserPage = any;

async function runSlackPermalinkInBrowser(
  page: BrowserPage,
  input: PermalinkCodeInput
): Promise<PermalinkPayload> {
  const sleep = (ms: number) => page.waitForTimeout(ms);
  await page.goto(input.permalink, { waitUntil: "domcontentloaded" });
  await sleep(2000);
  await page
    .waitForFunction(
      () => {
        return (
          Boolean(document.querySelector('[data-qa="message-text"]')) ||
          Boolean(document.querySelector("a.c-timestamp"))
        );
      },
      { timeout: 15000 }
    )
    .catch(() => null);
  await sleep(1000);

  const items = await page.evaluate((limit: number) => {
    const textOf = (element: Element, selector: string) => {
      const node = element.querySelector(selector);
      if (!node) {
        return null;
      }
      const raw = node instanceof HTMLElement ? node.innerText : node.textContent;
      const normalized = (raw ?? "").replace(/\s+/g, " ").trim();
      return normalized || null;
    };

    const messageRoots = Array.from(document.querySelectorAll('[data-qa="virtual-list-item"]'));
    const scoped = (
      messageRoots.length > 0
        ? messageRoots
        : Array.from(document.querySelectorAll('[data-qa="message-text"]')).map(
            (node) => node.closest("[role='listitem']") ?? node
          )
    )
      .filter((node): node is Element => node instanceof Element)
      .slice(-limit);

    return scoped.map((element) => {
      const timestamp = element.querySelector("a.c-timestamp");
      const messageUrl = timestamp instanceof HTMLAnchorElement ? timestamp.href : null;
      const slackTs = timestamp?.getAttribute("data-ts") ?? null;
      return {
        messageUrl,
        sender: textOf(element, '[data-qa="message_sender_name"]'),
        slackTs,
        text: textOf(element, '[data-qa="message-text"]'),
      };
    });
  }, input.limit);

  return {
    mode: "permalink",
    items,
    pageTitle: await page.title(),
    pageUrl: page.url(),
  };
}

async function readJsonFromStdin(): Promise<PlaySlackSearchAdapterRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    throw new Error("play-slack-search-adapter request body is empty");
  }
  return JSON.parse(raw) as PlaySlackSearchAdapterRequest;
}

function resolveWorkspaceUrl(request: PlaySlackSearchAdapterRequest): string {
  if (request.workspaceUrl) {
    try {
      const url = new URL(request.workspaceUrl);
      return `${url.protocol}//${url.host}`;
    } catch {
      throw new Error(`invalid workspaceUrl: ${request.workspaceUrl}`);
    }
  }
  if ("permalink" in request && request.permalink) {
    try {
      const url = new URL(request.permalink);
      return `${url.protocol}//${url.host}`;
    } catch {
      throw new Error(`invalid permalink: ${request.permalink}`);
    }
  }
  const fromEnv = process.env[PLAY_SLACK_SEARCH_WORKSPACE_URL_ENV]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  throw new Error(
    `workspace URL is required for play-slack-search adapter; set ${PLAY_SLACK_SEARCH_WORKSPACE_URL_ENV}`
  );
}

function buildPermalinkRequest(
  request: PlaySlackSearchRequest,
  workspaceUrl: string
): PlaySlackSearchRequest {
  if (request.mode === "permalink" || request.permalink) {
    return request;
  }
  const workspaceHost = new URL(workspaceUrl).host;
  const channelId = request.channelId;
  const messageTs =
    request.mode === "thread" ? (request.threadTs ?? request.messageTs) : request.messageTs;
  const threadTs = request.mode === "thread" ? (request.threadTs ?? request.messageTs) : undefined;
  const permalink = deriveSlackPermalink({ workspaceHost, channelId, messageTs, threadTs });
  if (!permalink) {
    throw new Error(`failed to derive permalink for mode=${request.mode}`);
  }
  return {
    mode: "permalink",
    permalink,
    workspaceUrl,
    limit: request.limit,
  };
}

function normalizeSearchPayload(payload: SearchPayloadLike): PlaySlackSearchResult {
  const items: PlaySlackSearchItem[] = payload.results.map((item) => ({
    ...(item.slackTs ? { ts: item.slackTs } : {}),
    text: item.text ?? "",
    ...(item.messageUrl ? { permalink: item.messageUrl } : {}),
  }));
  return {
    mode: "search",
    items,
    sourceUrl: payload.searchUrl,
    ...(payload.noResults ? { warnings: ["no-results"] } : {}),
  };
}

function normalizePermalinkPayload(payload: PermalinkPayload): PlaySlackSearchResult {
  const items: PlaySlackSearchItem[] = payload.items.map((item) => ({
    ...(item.slackTs ? { ts: item.slackTs } : {}),
    text: item.text ?? "",
    ...(item.messageUrl ? { permalink: item.messageUrl } : {}),
  }));
  return {
    mode: "permalink",
    items,
    sourceUrl: payload.pageUrl,
  };
}

function normalizeListUsersPayload(payload: UserListPayloadLike): PlaySlackSearchListUsersResult {
  const users = Array.isArray(payload.users)
    ? payload.users.map((user) => ({
        ...(typeof user.id === "string" ? { id: user.id } : {}),
        ...(typeof user.teamId === "string" ? { teamId: user.teamId } : {}),
        ...(typeof user.name === "string" ? { name: user.name } : {}),
        ...(typeof user.realName === "string" ? { realName: user.realName } : {}),
        ...(typeof user.displayName === "string" ? { displayName: user.displayName } : {}),
        ...(typeof user.displayNameNormalized === "string"
          ? { displayNameNormalized: user.displayNameNormalized }
          : {}),
        ...(typeof user.title === "string" ? { title: user.title } : {}),
        ...(typeof user.email === "string" ? { email: user.email } : {}),
        ...(typeof user.tz === "string" ? { tz: user.tz } : {}),
        ...(typeof user.updated === "number" ? { updated: user.updated } : {}),
        ...(typeof user.isAdmin === "boolean" ? { isAdmin: user.isAdmin } : {}),
        ...(typeof user.isAppUser === "boolean" ? { isAppUser: user.isAppUser } : {}),
        ...(typeof user.isBot === "boolean" ? { isBot: user.isBot } : {}),
        ...(typeof user.isDeleted === "boolean" ? { isDeleted: user.isDeleted } : {}),
        ...(typeof user.isOwner === "boolean" ? { isOwner: user.isOwner } : {}),
        ...(typeof user.isPrimaryOwner === "boolean"
          ? { isPrimaryOwner: user.isPrimaryOwner }
          : {}),
        ...(typeof user.isRestricted === "boolean" ? { isRestricted: user.isRestricted } : {}),
        ...(typeof user.isStranger === "boolean" ? { isStranger: user.isStranger } : {}),
        ...(typeof user.isUltraRestricted === "boolean"
          ? { isUltraRestricted: user.isUltraRestricted }
          : {}),
      }))
    : [];
  return {
    mode: "list-users",
    users,
    ...(typeof payload.listUrl === "string" ? { sourceUrl: payload.listUrl } : {}),
    ...(typeof payload.source === "string" ? { source: payload.source } : {}),
    ...(typeof payload.stateKey === "string" ? { stateKey: payload.stateKey } : {}),
    ...(typeof payload.totalUserCount === "number"
      ? { totalUserCount: payload.totalUserCount }
      : {}),
  };
}

function normalizeResolveChannelsPayload(
  payload: ResolveChannelsPayloadLike
): PlaySlackSearchResolveChannelResult {
  const channels = Array.isArray(payload.channels)
    ? payload.channels
        .filter(
          (
            channel
          ): channel is {
            channelId: string;
            channelName?: string | null;
            resolved: boolean;
            source?: string;
            stateKey?: string | null;
          } => typeof channel.channelId === "string" && typeof channel.resolved === "boolean"
        )
        .map((channel) => ({
          channelId: channel.channelId,
          resolved: channel.resolved,
          ...(typeof channel.channelName === "string" ? { channelName: channel.channelName } : {}),
          ...(typeof channel.source === "string" ? { source: channel.source } : {}),
          ...(typeof channel.stateKey === "string" ? { stateKey: channel.stateKey } : {}),
        }))
    : [];
  return {
    mode: "resolve-channel-id",
    channels,
    ...(typeof payload.listUrl === "string" ? { sourceUrl: payload.listUrl } : {}),
  };
}

export function extractThreadTsFromUrl(urlValue: string | undefined): string | undefined {
  if (!urlValue) {
    return undefined;
  }
  try {
    const url = new URL(urlValue);
    const threadTs = url.searchParams.get("thread_ts")?.trim();
    return threadTs && threadTs.length > 0 ? threadTs : undefined;
  } catch {
    return undefined;
  }
}

export function resolveThreadPermalinkFromMessage(
  request: PlaySlackSearchRequest,
  workspaceUrl: string,
  payload: PermalinkPayload
): string | undefined {
  if (!request.channelId) {
    return undefined;
  }
  const workspaceHost = new URL(workspaceUrl).host;
  const threadTs =
    request.threadTs ??
    extractThreadTsFromUrl(payload.pageUrl) ??
    extractThreadTsFromUrl(payload.items[0]?.messageUrl ?? undefined);
  if (!threadTs) {
    return undefined;
  }
  return deriveSlackPermalink({
    workspaceHost,
    channelId: request.channelId,
    messageTs: threadTs,
    threadTs,
  });
}

function getSearchSessionName(): string {
  const fromEnv = process.env.PLAY_SLACK_SEARCH_SESSION?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_SESSION;
}

function getSearchProfile(): string {
  const fromEnv = process.env.PLAY_SLACK_SEARCH_PROFILE?.trim();
  return normalizeProfilePath(fromEnv && fromEnv.length > 0 ? fromEnv : defaultProfilePath());
}

function runPermalinkPayload(permalink: string, limit: number, session: string): PermalinkPayload {
  return runJson<PermalinkPayload>([
    `-s=${session}`,
    "run-code",
    serializeBrowserCode(runSlackPermalinkInBrowser, {
      permalink,
      limit,
    }),
  ]);
}

export function executeAdapterRequest(
  request: PlaySlackSearchAdapterRequest,
  context: { workspaceUrl: string; session: string },
  deps: AdapterDeps = {
    executeSlackCommand,
    runPermalinkPayload,
  }
): PlaySlackSearchAdapterResult {
  const limit = "limit" in request ? (request.limit ?? 20) : 20;
  if (request.mode === "login") {
    return {
      mode: "login",
      items: [],
      instructions:
        "Slack login browser was opened. Ask the user to complete login in the browser and close it when finished.",
      sourceUrl: context.workspaceUrl,
    };
  }
  if (request.mode === "list-users") {
    const payload = deps.executeSlackCommand(
      {
        hydrate: request.hydrate ?? false,
        limit: request.limit ?? Number.MAX_SAFE_INTEGER,
        listChannels: false,
        listUsers: true,
        query: "",
        resolveChannelIds: [],
        workspaceUrl: context.workspaceUrl,
      },
      context.session
    ) as UserListPayloadLike;
    return normalizeListUsersPayload(payload);
  }
  if (request.mode === "resolve-channel-id") {
    const payload = deps.executeSlackCommand(
      {
        hydrate: false,
        limit: Number.MAX_SAFE_INTEGER,
        listChannels: false,
        listUsers: false,
        query: "",
        resolveChannelIds: request.channelIds,
        workspaceUrl: context.workspaceUrl,
      },
      context.session
    ) as ResolveChannelsPayloadLike;
    return normalizeResolveChannelsPayload(payload);
  }
  if (request.mode === "search") {
    const payload = deps.executeSlackCommand(
      {
        hydrate: false,
        limit,
        listChannels: false,
        listUsers: false,
        query: request.query ?? "",
        resolveChannelIds: [],
        workspaceUrl: context.workspaceUrl,
      },
      context.session
    ) as SearchPayloadLike;
    return normalizeSearchPayload(payload);
  }

  const permalinkRequest = buildPermalinkRequest(request, context.workspaceUrl);
  const messagePayload = deps.runPermalinkPayload(
    permalinkRequest.permalink!,
    limit,
    context.session
  );
  let normalized = normalizePermalinkPayload(messagePayload);
  const warnings = [...(normalized.warnings ?? [])];

  if (request.mode === "message") {
    const threadPermalink = resolveThreadPermalinkFromMessage(
      request,
      context.workspaceUrl,
      messagePayload
    );
    if (threadPermalink) {
      const threadPayload = deps.runPermalinkPayload(threadPermalink, limit, context.session);
      normalized = normalizePermalinkPayload(threadPayload);
    } else {
      warnings.push("thread-unresolved-from-message");
    }
  }

  return {
    mode: request.mode,
    items: normalized.items,
    sourceUrl: normalized.sourceUrl,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function main(): void {
  loadPackageEnv();
  let activeOpenedSession: string | undefined;
  const closeActiveSession = () => {
    if (!activeOpenedSession) {
      return;
    }
    try {
      safeCloseSession(activeOpenedSession);
    } catch {
      // ignore cleanup errors during shutdown
    } finally {
      activeOpenedSession = undefined;
    }
  };
  const terminate = (signal: NodeJS.Signals) => {
    closeActiveSession();
    process.exitCode = 128;
    process.stderr.write(`play_slack_search terminated by ${signal}\n`);
    process.exit();
  };
  process.once("SIGTERM", () => terminate("SIGTERM"));
  process.once("SIGINT", () => terminate("SIGINT"));
  void (async () => {
    const request = await readJsonFromStdin();
    const workspaceUrl = resolveWorkspaceUrl(request);
    const profile = getSearchProfile();
    const sessionName = getSearchSessionName();
    if (request.mode === "login") {
      const login = runInteractiveLogin({
        profile,
        requestedSession: sessionName,
        workspaceUrl,
      });
      process.stdout.write(
        `${JSON.stringify({
          instructions:
            "Slack login browser was opened. Ask the user to complete login in the browser and close it when finished.",
          items: [],
          mode: "login",
          sourceUrl: workspaceUrl,
          warnings: [`session=${login.session}`],
        })}\n`
      );
      return;
    }
    const prepared = prepareSession({
      profile,
      requestedSession: sessionName,
      workspaceUrl,
    });
    activeOpenedSession = prepared.openedSession ?? undefined;

    try {
      const result = executeAdapterRequest(request, {
        workspaceUrl,
        session: prepared.session,
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally {
      closeActiveSession();
    }
  })().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  main();
}
