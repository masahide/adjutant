import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { buildCustomToolDefinitions } from "../../../src/assistant/agent-session-factory.js";
import { PLAY_SLACK_SEARCH_ADAPTER_ENTRY_ENV } from "../../../src/assistant/play-slack-search-tool.js";

test("tool_hub slack/search は adapter script を spawn する", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "adjutant-play-slack-search-"));
  const adapterPath = join(tempDir, "fake-adapter.ts");
  writeFileSync(
    adapterPath,
    [
      "#!/usr/bin/env -S node --import tsx",
      'import process from "node:process";',
      "",
      "async function main(): Promise<void> {",
      "  const chunks: Buffer[] = [];",
      "  for await (const chunk of process.stdin) {",
      "    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));",
      "  }",
      '  const raw = Buffer.concat(chunks).toString("utf8");',
      "  const request = JSON.parse(raw);",
      '  if (request.mode === "list-users") {',
      "    process.stdout.write(JSON.stringify({",
      '      mode: "list-users",',
      "      users: [{ id: 'U123', name: 'alice', realName: 'Alice' }],",
      '      sourceUrl: request.workspaceUrl ?? "https://example.slack.com/client/T1"',
      '    }) + "\\n");',
      "    return;",
      "  }",
      '  if (request.mode === "resolve-channel-id") {',
      "    process.stdout.write(JSON.stringify({",
      '      mode: "resolve-channel-id",',
      "      channels: (request.channelIds ?? []).map((channelId) => ({",
      "        channelId,",
      "        channelName: `name:${channelId}`,",
      "        resolved: true",
      "      })),",
      '      sourceUrl: request.workspaceUrl ?? "https://example.slack.com/client/T1"',
      '    }) + "\\n");',
      "    return;",
      "  }",
      "  process.stdout.write(JSON.stringify({",
      "    mode: request.mode,",
      '    sourceUrl: request.workspaceUrl ?? "https://example.slack.com",',
      "    items: [{",
      '      ts: request.messageTs ?? request.threadTs ?? "1773481739.636659",',
      "      text: `echo:${request.mode}`,",
      '      permalink: request.permalink ?? "https://example.slack.com/archives/C1/p1"',
      "    }]",
      '  }) + "\\n");',
      "}",
      "",
      "void main();",
      "",
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

  const tool = buildCustomToolDefinitions({
    workspaceDir: process.cwd(),
    memoryScope: "spoke",
  }).find((entry) => entry.name === "tool_hub");

  assert.ok(tool);
  assert.ok(tool.execute);

  const result = await tool.execute!(
    "tool-call-1",
    {
      provider: "slack",
      action: "search",
      args: {
        mode: "message",
        channelId: "C1",
        messageTs: "1773481739.636659",
        workspaceUrl: "https://workspace-b.slack.com",
      },
    },
    new AbortController().signal,
    async () => {},
    {} as never
  );

  const details = result.details as {
    ok: boolean;
    provider: string;
    action: string;
    data: {
      mode: string;
      items: Array<{ text: string; ts?: string }>;
      sourceUrl?: string;
    };
  };
  assert.equal(details.ok, true);
  assert.equal(details.provider, "slack");
  assert.equal(details.action, "search");
  assert.equal(details.data.mode, "message");
  assert.equal(details.data.sourceUrl, "https://workspace-b.slack.com");
  assert.equal(details.data.items[0]?.text, "echo:message");
  assert.equal(details.data.items[0]?.ts, "1773481739.636659");
});

test("tool_hub slack/list-users は adapter script を spawn する", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "adjutant-play-slack-search-list-users-"));
  const adapterPath = join(tempDir, "fake-adapter.ts");
  writeFileSync(
    adapterPath,
    [
      "#!/usr/bin/env -S node --import tsx",
      'import process from "node:process";',
      "",
      "async function main(): Promise<void> {",
      "  const chunks: Buffer[] = [];",
      "  for await (const chunk of process.stdin) {",
      "    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));",
      "  }",
      '  const raw = Buffer.concat(chunks).toString("utf8");',
      "  const request = JSON.parse(raw);",
      "  process.stdout.write(JSON.stringify({",
      '    mode: "list-users",',
      "    users: [{ id: 'U123', name: 'alice' }],",
      '    sourceUrl: request.workspaceUrl ?? "https://example.slack.com/client/T1"',
      '  }) + "\\n");',
      "}",
      "",
      "void main();",
      "",
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

  const tool = buildCustomToolDefinitions({
    workspaceDir: process.cwd(),
    memoryScope: "spoke",
  }).find((entry) => entry.name === "tool_hub");

  assert.ok(tool);
  assert.ok(tool.execute);

  const result = await tool.execute!(
    "tool-call-list-users",
    {
      provider: "slack",
      action: "list-users",
      args: {
        workspaceUrl: "https://workspace-b.slack.com",
        limit: 5,
      },
    },
    new AbortController().signal,
    async () => {},
    {} as never
  );

  const details = result.details as {
    ok: boolean;
    provider: string;
    action: string;
    data: {
      mode: string;
      users: Array<{ id?: string; name?: string }>;
      sourceUrl?: string;
    };
  };
  assert.equal(details.ok, true);
  assert.equal(details.provider, "slack");
  assert.equal(details.action, "list-users");
  assert.equal(details.data.mode, "list-users");
  assert.equal(details.data.sourceUrl, "https://workspace-b.slack.com");
  assert.equal(details.data.users[0]?.id, "U123");
  assert.equal(details.data.users[0]?.name, "alice");
});

test("tool_hub slack/save-users は workspace 配下へ users.json を保存する", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "adjutant-play-slack-search-save-users-"));
  const adapterPath = join(tempDir, "fake-adapter.ts");
  writeFileSync(
    adapterPath,
    [
      "#!/usr/bin/env -S node --import tsx",
      'import process from "node:process";',
      "",
      "async function main(): Promise<void> {",
      "  const chunks: Buffer[] = [];",
      "  for await (const chunk of process.stdin) {",
      "    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));",
      "  }",
      '  const raw = Buffer.concat(chunks).toString("utf8");',
      "  const request = JSON.parse(raw);",
      "  process.stdout.write(JSON.stringify({",
      '    mode: "list-users",',
      "    users: [{ id: 'U123', name: 'alice' }, { id: 'U456', name: 'bob' }],",
      '    sourceUrl: request.workspaceUrl ?? "https://workspace-b.slack.com/client/T1"',
      '  }) + "\\n");',
      "}",
      "",
      "void main();",
      "",
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

  const workspaceDir = join(tempDir, "workspace");
  const tool = buildCustomToolDefinitions({
    workspaceDir,
    memoryScope: "spoke",
  }).find((entry) => entry.name === "tool_hub");

  assert.ok(tool);
  assert.ok(tool.execute);

  const result = await tool.execute!(
    "tool-call-save-users",
    {
      provider: "slack",
      action: "save-users",
      args: {
        workspaceUrl: "https://workspace-b.slack.com",
        hydrate: true,
      },
    },
    new AbortController().signal,
    async () => {},
    {} as never
  );

  const details = result.details as {
    ok: boolean;
    provider: string;
    action: string;
    data: {
      mode: string;
      path: string;
      workspaceHost: string;
      workspaceUrl: string;
      userCount: number;
    };
  };
  assert.equal(details.ok, true);
  assert.equal(details.provider, "slack");
  assert.equal(details.action, "save-users");
  assert.equal(details.data.mode, "save-users");
  assert.equal(details.data.workspaceHost, "workspace-b.slack.com");
  assert.equal(details.data.workspaceUrl, "https://workspace-b.slack.com");
  assert.equal(details.data.userCount, 2);

  const savedPath = join(
    workspaceDir,
    "tools",
    "play-slack-search",
    "workspace-b.slack.com",
    "users.json"
  );
  assert.equal(details.data.path, savedPath);
  const saved = JSON.parse(readFileSync(savedPath, "utf8")) as {
    workspaceUrl: string;
    workspaceHost: string;
    userCount: number;
    result: { users: Array<{ id?: string; name?: string }> };
  };
  assert.equal(saved.workspaceUrl, "https://workspace-b.slack.com");
  assert.equal(saved.workspaceHost, "workspace-b.slack.com");
  assert.equal(saved.userCount, 2);
  assert.equal(saved.result.users[0]?.id, "U123");
  assert.equal(saved.result.users[1]?.name, "bob");
});

test("tool_hub slack/resolve-channel-id は adapter script を spawn する", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "adjutant-play-slack-search-resolve-channel-"));
  const adapterPath = join(tempDir, "fake-adapter.ts");
  writeFileSync(
    adapterPath,
    [
      "#!/usr/bin/env -S node --import tsx",
      'import process from "node:process";',
      "",
      "async function main(): Promise<void> {",
      "  const chunks: Buffer[] = [];",
      "  for await (const chunk of process.stdin) {",
      "    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));",
      "  }",
      '  const raw = Buffer.concat(chunks).toString("utf8");',
      "  const request = JSON.parse(raw);",
      "  process.stdout.write(JSON.stringify({",
      '    mode: "resolve-channel-id",',
      "    channels: (request.channelIds ?? []).map((channelId) => ({ channelId, channelName: `name:${channelId}`, resolved: true })),",
      '    sourceUrl: request.workspaceUrl ?? "https://example.slack.com/client/T1"',
      '  }) + "\\n");',
      "}",
      "",
      "void main();",
      "",
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

  const tool = buildCustomToolDefinitions({
    workspaceDir: process.cwd(),
    memoryScope: "spoke",
  }).find((entry) => entry.name === "tool_hub");

  assert.ok(tool);
  assert.ok(tool.execute);

  const result = await tool.execute!(
    "tool-call-resolve-channel",
    {
      provider: "slack",
      action: "resolve-channel-id",
      args: {
        workspaceUrl: "https://workspace-b.slack.com",
        channelIds: ["C123"],
      },
    },
    new AbortController().signal,
    async () => {},
    {} as never
  );

  const details = result.details as {
    ok: boolean;
    provider: string;
    action: string;
    data: {
      mode: string;
      channels: Array<{ channelId: string; channelName?: string; resolved: boolean }>;
      sourceUrl?: string;
    };
  };
  assert.equal(details.ok, true);
  assert.equal(details.provider, "slack");
  assert.equal(details.action, "resolve-channel-id");
  assert.equal(details.data.mode, "resolve-channel-id");
  assert.equal(details.data.sourceUrl, "https://workspace-b.slack.com");
  assert.equal(details.data.channels[0]?.channelId, "C123");
  assert.equal(details.data.channels[0]?.channelName, "name:C123");
  assert.equal(details.data.channels[0]?.resolved, true);
});
