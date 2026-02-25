import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

function getFileTool(
  session: AgentSessionLike,
  name: "read" | "write" | "edit" | "grep" | "find" | "ls"
): ToolLike {
  return getTool(session, name);
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

  it("sandbox 有効時は read/write/edit/grep/find/ls が docker 経由になる", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "adjutant-session-file-tool-sandbox-"));
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

      const readTool = getFileTool(session, "read");
      const writeTool = getFileTool(session, "write");
      const editTool = getFileTool(session, "edit");
      const grepTool = getFileTool(session, "grep");
      const findTool = getFileTool(session, "find");
      const lsTool = getFileTool(session, "ls");

      await assert.rejects(
        readTool.execute("tool-read", { path: "/workspace/test.txt" } as unknown),
        /docker|container|not found|No such container|Command exited with code/i
      );
      await assert.rejects(
        writeTool.execute("tool-write", { path: "/workspace/test.txt", content: "x" } as unknown),
        /docker|container|not found|No such container|Command exited with code/i
      );
      await assert.rejects(
        editTool.execute("tool-edit", {
          path: "/workspace/test.txt",
          oldText: "a",
          newText: "b",
        } as unknown),
        /docker|container|not found|No such container|Command exited with code/i
      );
      await assert.rejects(
        grepTool.execute("tool-grep", { pattern: "TODO", path: "/workspace" } as unknown),
        /docker|container|not found|No such container|Command exited with code/i
      );
      await assert.rejects(
        findTool.execute("tool-find", { pattern: "*.ts", path: "/workspace" } as unknown),
        /docker|container|not found|No such container|Command exited with code/i
      );
      await assert.rejects(
        lsTool.execute("tool-ls", { path: "/workspace" } as unknown),
        /docker|container|not found|No such container|Command exited with code/i
      );

      session.dispose();
    } finally {
      configureSandbox(null);
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("sandbox 非対象（non-main + main scope）では file tools がローカル実行される", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "adjutant-session-file-tool-local-"));
    await writeFile(join(workspaceDir, "note.txt"), "local-file-check\n", "utf-8");
    configureSandbox({
      containerName: `adjutant-missing-${Date.now()}`,
      hostWorkspaceDir: workspaceDir,
      workdir: "/workspace",
      mode: "non-main",
    });
    try {
      const session = await createTestSession({
        workspaceDir,
        memoryScope: "main",
        isHeartbeat: false,
      });
      const readTool = getFileTool(session, "read");
      const result = (await readTool.execute("tool-call-read-local", {
        path: "note.txt",
      } as unknown)) as { content?: Array<{ type: string; text?: string }> };
      const text = result.content?.[0]?.text ?? "";
      assert.match(text, /local-file-check/);
      session.dispose();
    } finally {
      configureSandbox(null);
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("heartbeat セッションでは report_heartbeat_status ツールを登録しない", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "adjutant-session-heartbeat-"));
    configureSandbox(null);
    try {
      const session = await createTestSession({
        workspaceDir,
        memoryScope: "spoke",
        isHeartbeat: true,
      });
      assert.equal(typeof session.sendCustomMessage, "function");
      const tools =
        (session as AgentSessionLike & { state: { tools: ToolLike[] } }).state?.tools ?? [];
      const reportTool = tools.find((tool) => tool.name === "report_heartbeat_status");
      assert.equal(reportTool, undefined);
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
