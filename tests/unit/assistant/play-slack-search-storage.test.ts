import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  resolvePlaySlackSearchWorkspaceHost,
  resolvePlaySlackSearchWorkspaceToolsDir,
  savePlaySlackSearchUsersResult,
} from "../../../src/assistant/play-slack-search-storage.js";

test("resolvePlaySlackSearchWorkspaceHost derives host from workspace url", () => {
  assert.equal(
    resolvePlaySlackSearchWorkspaceHost("https://workspace-b.slack.com/client/T1"),
    "workspace-b.slack.com"
  );
});

test("resolvePlaySlackSearchWorkspaceToolsDir uses workspace/tools/play-slack-search/<host>", () => {
  assert.equal(
    resolvePlaySlackSearchWorkspaceToolsDir("/tmp/workspace", "https://workspace-b.slack.com"),
    "/tmp/workspace/tools/play-slack-search/workspace-b.slack.com"
  );
});

test("savePlaySlackSearchUsersResult writes users.json under workspace-scoped directory", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "adjutant-play-slack-search-storage-"));
  try {
    const saved = await savePlaySlackSearchUsersResult({
      workspaceDir,
      requestedWorkspaceUrl: "https://workspace-b.slack.com",
      now: () => "2026-03-16T00:00:00.000Z",
      result: {
        mode: "list-users",
        users: [
          { id: "U123", name: "alice" },
          { id: "U456", name: "bob" },
        ],
        sourceUrl: "https://workspace-b.slack.com/client/T1",
      },
    });

    const expectedPath = join(
      workspaceDir,
      "tools",
      "play-slack-search",
      "workspace-b.slack.com",
      "users.json"
    );
    assert.deepEqual(saved, {
      mode: "save-users",
      path: expectedPath,
      workspaceHost: "workspace-b.slack.com",
      workspaceUrl: "https://workspace-b.slack.com",
      userCount: 2,
      sourceUrl: "https://workspace-b.slack.com/client/T1",
    });

    const raw = await readFile(expectedPath, "utf8");
    const parsed = JSON.parse(raw) as {
      schema: string;
      generatedAt: string;
      workspaceUrl: string;
      workspaceHost: string;
      userCount: number;
      result: { users: Array<{ id?: string; name?: string }> };
    };
    assert.equal(parsed.schema, "adjutant.play-slack-search.users.v1");
    assert.equal(parsed.generatedAt, "2026-03-16T00:00:00.000Z");
    assert.equal(parsed.workspaceUrl, "https://workspace-b.slack.com");
    assert.equal(parsed.workspaceHost, "workspace-b.slack.com");
    assert.equal(parsed.userCount, 2);
    assert.equal(parsed.result.users[0]?.id, "U123");
    assert.equal(parsed.result.users[1]?.name, "bob");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
