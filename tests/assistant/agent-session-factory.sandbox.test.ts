import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import {
  configureSandbox,
  createAgentSessionFromSdk,
  type AgentSessionLike,
} from "../../src/assistant/agent-session-factory.js";

type BashToolLike = {
  name: string;
  execute: (
    toolCallId: string,
    params: { command: string; timeout?: number },
    signal?: AbortSignal,
    onUpdate?: unknown
  ) => Promise<unknown>;
};

function getBashTool(session: AgentSessionLike): BashToolLike {
  const tools = (session as AgentSessionLike & { state: { tools: BashToolLike[] } }).state?.tools ?? [];
  const bash = tools.find((tool) => tool.name === "bash");
  assert.ok(bash, "bash tool should be available");
  return bash;
}

async function createTestSession(params: {
  workspaceDir: string;
  memoryScope: "main" | "spoke";
  isHeartbeat?: boolean;
}): Promise<AgentSessionLike> {
  const sessionManager = SessionManager.create(params.workspaceDir, join(params.workspaceDir, ".sessions"));
  const created = await createAgentSessionFromSdk({
    sessionManager,
    runId: `test-run-${Date.now()}`,
    sessionKey: "sandbox-test",
    workspaceDir: params.workspaceDir,
    memoryScope: params.memoryScope,
    isHeartbeat: params.isHeartbeat,
  });
  return created.session;
}

describe("agent-session-factory sandbox bash", () => {
  it("sandbox 有効時は bash が docker 経由になる", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "adjutant-session-sandbox-"));
    const containerName = `adjutant-missing-${Date.now()}`;
    configureSandbox({
      containerName,
      hostWorkspaceDir: workspaceDir,
      workdir: "/workspace",
      mode: "all",
    });

    try {
      const session = await createTestSession({
        workspaceDir,
        memoryScope: "spoke",
        isHeartbeat: false,
      });
      const bashTool = getBashTool(session);
      await assert.rejects(
        bashTool.execute("tool-call-1", { command: "echo sandbox-check" }),
        /docker|container|not found|Command exited with code/i
      );
      session.dispose();
    } finally {
      configureSandbox(null);
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("sandbox 無効時は bash がローカル実行される", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "adjutant-session-local-"));
    configureSandbox(null);
    try {
      const session = await createTestSession({
        workspaceDir,
        memoryScope: "spoke",
        isHeartbeat: false,
      });
      const bashTool = getBashTool(session);
      const result = (await bashTool.execute("tool-call-2", {
        command: "echo local-check",
      })) as { content?: Array<{ type: string; text?: string }> };
      const text = result.content?.[0]?.text ?? "";
      assert.match(text, /local-check/);
      session.dispose();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});

