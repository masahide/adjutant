import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    cwd: process.cwd(),
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
