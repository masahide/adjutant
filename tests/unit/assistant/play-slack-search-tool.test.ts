import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  createPlaySlackSearchToolDefinition,
  DEFAULT_TIMEOUT_MS,
  executePlaySlackSearchListUsersRequest,
  executePlaySlackSearchRequest,
  executePlaySlackSearchResolveChannelRequest,
  PLAY_SLACK_SEARCH_ADAPTER_ENTRY_ENV,
  PLAY_SLACK_SEARCH_TOOL_NAME,
  validatePlaySlackSearchListUsersRequest,
  validatePlaySlackSearchRequest,
  validatePlaySlackSearchResolveChannelRequest,
  type PlaySlackSearchListUsersRequest,
  type PlaySlackSearchRequest,
  type PlaySlackSearchResolveChannelRequest,
} from "../../../src/assistant/play-slack-search-tool.js";

test("validatePlaySlackSearchRequest accepts thread mode with permalink fallback only", () => {
  const request = validatePlaySlackSearchRequest({
    mode: "thread",
    permalink: "https://example.slack.com/archives/C1/p123",
  });

  assert.equal(request.mode, "thread");
  assert.equal(request.permalink, "https://example.slack.com/archives/C1/p123");
  assert.equal(request.channelId, undefined);
});

test("validatePlaySlackSearchRequest keeps workspaceUrl for multi-workspace routing", () => {
  const request = validatePlaySlackSearchRequest({
    mode: "message",
    channelId: "C1",
    messageTs: "1773481739.636659",
    permalink: "https://workspace-b.slack.com/archives/C1/p1773481739636659",
    workspaceUrl: "https://workspace-b.slack.com",
  });

  assert.equal(request.workspaceUrl, "https://workspace-b.slack.com");
  assert.equal(request.permalink, "https://workspace-b.slack.com/archives/C1/p1773481739636659");
});

test("validatePlaySlackSearchRequest accepts login mode without extra args", () => {
  const request = validatePlaySlackSearchRequest({
    mode: "login",
    workspaceUrl: "https://workspace-b.slack.com",
  });

  assert.equal(request.mode, "login");
  assert.equal(request.workspaceUrl, "https://workspace-b.slack.com");
});

test("validatePlaySlackSearchRequest rejects message mode without channelId", () => {
  assert.throws(
    () =>
      validatePlaySlackSearchRequest({
        mode: "message",
        messageTs: "1773481739.636659",
      }),
    /channelId and messageTs required/
  );
});

test("validatePlaySlackSearchRequest rejects search mode without query", () => {
  assert.throws(
    () =>
      validatePlaySlackSearchRequest({
        mode: "search",
      }),
    /query required/
  );
});

test("validatePlaySlackSearchRequest rejects permalink mode without permalink", () => {
  assert.throws(
    () =>
      validatePlaySlackSearchRequest({
        mode: "permalink",
      }),
    /permalink required/
  );
});

test("validatePlaySlackSearchListUsersRequest accepts optional hydrate and limit", () => {
  const request = validatePlaySlackSearchListUsersRequest({
    workspaceUrl: "https://workspace-b.slack.com",
    limit: 10,
    hydrate: true,
  });

  assert.deepEqual(request, {
    mode: "list-users",
    workspaceUrl: "https://workspace-b.slack.com",
    limit: 10,
    hydrate: true,
  });
});

test("validatePlaySlackSearchResolveChannelRequest requires non-empty channelIds", () => {
  const request = validatePlaySlackSearchResolveChannelRequest({
    workspaceUrl: "https://workspace-b.slack.com",
    channelIds: ["C123", "C456"],
  });

  assert.deepEqual(request, {
    mode: "resolve-channel-id",
    workspaceUrl: "https://workspace-b.slack.com",
    channelIds: ["C123", "C456"],
  });

  assert.throws(
    () =>
      validatePlaySlackSearchResolveChannelRequest({
        channelIds: [],
      }),
    /channelIds must be a non-empty string array/
  );
});

test("executePlaySlackSearchRequest forwards timeout and cwd to runner", async () => {
  const calls: Array<{ request: PlaySlackSearchRequest; cwd: string; timeoutMs: number }> = [];

  const result = await executePlaySlackSearchRequest(
    {
      mode: "search",
      query: "from:<@U123>",
    },
    {
      cwd: "/tmp/workspace",
      timeoutMs: 1234,
      runCommand: async (request, options) => {
        calls.push({ request, cwd: options.cwd, timeoutMs: options.timeoutMs });
        return {
          mode: "search",
          items: [{ text: "hello", permalink: "https://example.slack.com/archives/C1/p1" }],
        };
      },
    }
  );

  assert.equal(result.mode, "search");
  assert.deepEqual(calls, [
    {
      request: { mode: "search", query: "from:<@U123>" },
      cwd: "/tmp/workspace",
      timeoutMs: 1234,
    },
  ]);
});

test("createPlaySlackSearchToolDefinition exposes tool name and returns details", async () => {
  const tool = createPlaySlackSearchToolDefinition("/tmp/workspace", {
    runCommand: async () => ({
      mode: "permalink",
      items: [{ text: "message", ts: "1773481739.636659" }],
      sourceUrl: "https://example.slack.com/archives/C1/p1",
    }),
  });

  assert.equal(tool.name, PLAY_SLACK_SEARCH_TOOL_NAME);
  assert.ok(tool.execute);
  const result = await tool.execute!(
    "call-1",
    {
      mode: "permalink",
      permalink: "https://example.slack.com/archives/C1/p1",
    },
    new AbortController().signal,
    async () => {},
    {} as never
  );

  const details = result.details as {
    mode: string;
    items: Array<{ text: string }>;
  };
  assert.equal(details.mode, "permalink");
  assert.equal(details.items.length, 1);
  const firstContent = result.content[0];
  assert.equal(firstContent?.type, "text");
  assert.match(
    firstContent?.type === "text" ? firstContent.text : "",
    /play_slack_search completed/
  );
});

test("createPlaySlackSearchToolDefinition supports login mode", async () => {
  const tool = createPlaySlackSearchToolDefinition("/tmp/workspace", {
    runCommand: async () => ({
      mode: "login",
      items: [],
      instructions: "complete login and close the browser",
      sourceUrl: "https://example.slack.com",
    }),
  });

  const result = await tool.execute!(
    "call-2",
    {
      mode: "login",
      workspaceUrl: "https://example.slack.com",
    },
    new AbortController().signal,
    async () => {},
    {} as never
  );

  const details = result.details as {
    mode: string;
    instructions?: string;
    items: Array<{ text: string }>;
  };
  assert.equal(details.mode, "login");
  assert.equal(details.instructions, "complete login and close the browser");
  assert.equal(details.items.length, 0);
});

test("executePlaySlackSearchRequest uses default timeout when not overridden", async () => {
  let capturedTimeout = 0;
  await executePlaySlackSearchRequest(
    {
      mode: "search",
      query: "hello",
    },
    {
      cwd: "/tmp/workspace",
      runCommand: async (_request, options) => {
        capturedTimeout = options.timeoutMs;
        return { mode: "search", items: [] };
      },
    }
  );

  assert.equal(capturedTimeout, DEFAULT_TIMEOUT_MS);
});

test("executePlaySlackSearchListUsersRequest forwards timeout and cwd to runner", async () => {
  const calls: Array<{ request: PlaySlackSearchListUsersRequest; cwd: string; timeoutMs: number }> =
    [];

  const result = await executePlaySlackSearchListUsersRequest(
    {
      mode: "list-users",
      hydrate: true,
      limit: 25,
    },
    {
      cwd: "/tmp/workspace",
      timeoutMs: 2345,
      runCommand: async (request, options) => {
        calls.push({ request, cwd: options.cwd, timeoutMs: options.timeoutMs });
        return {
          mode: "list-users",
          users: [{ id: "U123", name: "alice" }],
          sourceUrl: "https://example.slack.com/client/T1",
        };
      },
    }
  );

  assert.equal(result.mode, "list-users");
  assert.deepEqual(calls, [
    {
      request: { mode: "list-users", hydrate: true, limit: 25 },
      cwd: "/tmp/workspace",
      timeoutMs: 2345,
    },
  ]);
});

test("executePlaySlackSearchResolveChannelRequest forwards request to runner", async () => {
  const calls: Array<{
    request: PlaySlackSearchResolveChannelRequest;
    cwd: string;
    timeoutMs: number;
  }> = [];

  const result = await executePlaySlackSearchResolveChannelRequest(
    {
      mode: "resolve-channel-id",
      workspaceUrl: "https://workspace-b.slack.com",
      channelIds: ["C123"],
    },
    {
      cwd: "/tmp/workspace",
      runCommand: async (request, options) => {
        calls.push({ request, cwd: options.cwd, timeoutMs: options.timeoutMs });
        return {
          mode: "resolve-channel-id",
          channels: [{ channelId: "C123", channelName: "general", resolved: true }],
          sourceUrl: "https://example.slack.com/client/T1",
        };
      },
    }
  );

  assert.equal(result.mode, "resolve-channel-id");
  assert.deepEqual(calls, [
    {
      request: {
        mode: "resolve-channel-id",
        workspaceUrl: "https://workspace-b.slack.com",
        channelIds: ["C123"],
      },
      cwd: "/tmp/workspace",
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  ]);
});

test("runPlaySlackSearchAdapter は timeout 時に SIGTERM を送り child cleanup を待つ", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "adjutant-play-slack-search-timeout-"));
  const markerPath = join(tempDir, "cleanup.txt");
  const adapterPath = join(tempDir, "timeout-adapter.mjs");
  writeFileSync(
    adapterPath,
    [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      `const markerPath = ${JSON.stringify(markerPath)};`,
      'process.once("SIGTERM", () => { writeFileSync(markerPath, "cleaned", "utf8"); process.exit(0); });',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    "utf8"
  );

  const previous = process.env[PLAY_SLACK_SEARCH_ADAPTER_ENTRY_ENV];
  process.env[PLAY_SLACK_SEARCH_ADAPTER_ENTRY_ENV] = adapterPath;
  t.after(() => {
    if (previous === undefined) {
      delete process.env[PLAY_SLACK_SEARCH_ADAPTER_ENTRY_ENV];
    } else {
      process.env[PLAY_SLACK_SEARCH_ADAPTER_ENTRY_ENV] = previous;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  await assert.rejects(
    () =>
      executePlaySlackSearchRequest(
        { mode: "search", query: "hello" },
        {
          cwd: process.cwd(),
          timeoutMs: 1000,
        }
      ),
    /timeout after 1000ms/
  );

  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (existsSync(markerPath)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(existsSync(markerPath), "cleanup marker should be written after SIGTERM");
  const cleanupMarker = readFileSync(markerPath, "utf8");
  assert.equal(cleanupMarker, "cleaned");
});

test("runPlaySlackSearchAdapter は SIGTERM で終了しない子に対して SIGKILL へフォールバックする", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "adjutant-play-slack-search-force-kill-"));
  const termMarkerPath = join(tempDir, "term.txt");
  const adapterPath = join(tempDir, "timeout-adapter-ignore-term.mjs");
  writeFileSync(
    adapterPath,
    [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      `const termMarkerPath = ${JSON.stringify(termMarkerPath)};`,
      'process.once("SIGTERM", () => { writeFileSync(termMarkerPath, "saw-term", "utf8"); });',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    "utf8"
  );

  const previous = process.env[PLAY_SLACK_SEARCH_ADAPTER_ENTRY_ENV];
  process.env[PLAY_SLACK_SEARCH_ADAPTER_ENTRY_ENV] = adapterPath;
  t.after(() => {
    if (previous === undefined) {
      delete process.env[PLAY_SLACK_SEARCH_ADAPTER_ENTRY_ENV];
    } else {
      process.env[PLAY_SLACK_SEARCH_ADAPTER_ENTRY_ENV] = previous;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  await assert.rejects(
    () =>
      executePlaySlackSearchRequest(
        { mode: "search", query: "hello" },
        {
          cwd: process.cwd(),
          timeoutMs: 1000,
        }
      ),
    /timeout after 1000ms \(forced kill\)/
  );

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (existsSync(termMarkerPath)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const termMarker = readFileSync(termMarkerPath, "utf8");
  assert.equal(termMarker, "saw-term");
});
