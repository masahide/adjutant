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

type ToolLike = {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown
  ) => Promise<unknown>;
};

function getTool(session: AgentSessionLike, name: string): ToolLike {
  const tools = (session as AgentSessionLike & { state: { tools: ToolLike[] } }).state?.tools ?? [];
  const found = tools.find((tool) => tool.name === name);
  assert.ok(found, `${name} tool should be available`);
  return found;
}

function getBashTool(session: AgentSessionLike): ToolLike {
  return getTool(session, "bash");
}

async function createTestSession(params: {
  workspaceDir: string;
  memoryScope: "main" | "spoke";
  isHeartbeat?: boolean;
}): Promise<AgentSessionLike> {
  const sessionManager = SessionManager.create(
    params.workspaceDir,
    join(params.workspaceDir, ".sessions")
  );
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
        bashTool.execute("tool-call-1", { command: "echo sandbox-check" } as unknown),
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
      } as unknown)) as { content?: Array<{ type: string; text?: string }> };
      const text = result.content?.[0]?.text ?? "";
      assert.match(text, /local-check/);
      session.dispose();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("heartbeat セッションでは report_heartbeat_status ツールが利用できる", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "adjutant-session-heartbeat-"));
    configureSandbox(null);
    try {
      const session = await createTestSession({
        workspaceDir,
        memoryScope: "spoke",
        isHeartbeat: true,
      });
      assert.equal(typeof session.sendCustomMessage, "function");
      const reportTool = getTool(session, "report_heartbeat_status");
      const result = (await reportTool.execute("tool-call-heartbeat", {
        status: "no_action_needed",
        notify: false,
        reason: "no urgent items",
      })) as {
        details?: {
          status?: string;
          notify?: boolean;
          reason?: string;
        };
      };
      assert.deepEqual(result.details, {
        status: "no_action_needed",
        notify: false,
        reason: "no urgent items",
      });
      session.dispose();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("appendCustomEntry は this バインド済みで関数として切り出して呼べる", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "adjutant-session-custom-entry-"));
    configureSandbox(null);
    try {
      const session = await createTestSession({
        workspaceDir,
        memoryScope: "spoke",
        isHeartbeat: false,
      });
      assert.equal(typeof session.appendCustomEntry, "function");
      const appendEntry = session.appendCustomEntry;
      assert.equal(typeof appendEntry, "function");
      const entryId = appendEntry!("adjutant:test", { ok: true });
      assert.equal(typeof entryId, "string");
      assert.equal(entryId.length > 0, true);
      session.dispose();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
