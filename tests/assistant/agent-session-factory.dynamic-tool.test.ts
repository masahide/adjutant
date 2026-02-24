import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { ToolHubResult } from "../../src/assistant/dynamic-tool/index.js";
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

function getToolNames(session: AgentSessionLike): string[] {
  const tools = (session as AgentSessionLike & { state: { tools: ToolLike[] } }).state?.tools ?? [];
  return tools.map((tool) => tool.name);
}

async function createTestSession(workspaceDir: string): Promise<AgentSessionLike> {
  const sessionManager = SessionManager.create(workspaceDir, join(workspaceDir, ".sessions"));
  const created = await createAgentSessionFromSdk({
    sessionManager,
    runId: `tool-hub-run-${Date.now()}`,
    sessionKey: "tool-hub-test",
    workspaceDir,
    memoryScope: "spoke",
    isHeartbeat: false,
    memoryWriteEnabled: false,
  });
  return created.session;
}

describe("agent-session-factory dynamic tool", () => {
  it("ADJUTANT_SLACK_API_ENABLED 未設定時でも slack provider は有効", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "adjutant-tool-hub-slack-default-"));
    const previousDynamic = process.env.ADJUTANT_DYNAMIC_TOOL_ENABLED;
    const previousSlackEnabled = process.env.ADJUTANT_SLACK_API_ENABLED;
    process.env.ADJUTANT_DYNAMIC_TOOL_ENABLED = "1";
    delete process.env.ADJUTANT_SLACK_API_ENABLED;
    configureSandbox(null);
    try {
      const session = await createTestSession(workspaceDir);
      const tools =
        (session as AgentSessionLike & { state: { tools: ToolLike[] } }).state?.tools ?? [];
      const toolHub = tools.find((tool) => tool.name === "tool_hub");
      assert.ok(toolHub, "tool_hub should be available");

      const result = (await toolHub!.execute("tool-call-default", {})) as {
        details?: ToolHubResult & {
          data?: { providers?: Array<{ name?: string }> };
        };
      };
      assert.equal(result.details?.ok, true);
      if (result.details?.ok) {
        const providers = (result.details.data as { providers?: Array<{ name?: string }> })
          ?.providers;
        assert.equal(providers?.some((provider) => provider.name === "slack") ?? false, true);
      }
      session.dispose();
    } finally {
      if (previousDynamic === undefined) {
        delete process.env.ADJUTANT_DYNAMIC_TOOL_ENABLED;
      } else {
        process.env.ADJUTANT_DYNAMIC_TOOL_ENABLED = previousDynamic;
      }
      if (previousSlackEnabled === undefined) {
        delete process.env.ADJUTANT_SLACK_API_ENABLED;
      } else {
        process.env.ADJUTANT_SLACK_API_ENABLED = previousSlackEnabled;
      }
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("ADJUTANT_SLACK_API_ENABLED=1 のとき catalog に slack provider が出る", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "adjutant-tool-hub-slack-provider-"));
    const previousDynamic = process.env.ADJUTANT_DYNAMIC_TOOL_ENABLED;
    const previousSlackEnabled = process.env.ADJUTANT_SLACK_API_ENABLED;
    const previousXoxc = process.env.ADJUTANT_SLACK_XOXC_TOKEN;
    const previousXoxd = process.env.ADJUTANT_SLACK_XOXD_TOKEN;
    process.env.ADJUTANT_DYNAMIC_TOOL_ENABLED = "1";
    process.env.ADJUTANT_SLACK_API_ENABLED = "1";
    process.env.ADJUTANT_SLACK_XOXC_TOKEN = "xoxc-test";
    process.env.ADJUTANT_SLACK_XOXD_TOKEN = "xoxd-test";
    configureSandbox(null);
    try {
      const session = await createTestSession(workspaceDir);
      const tools =
        (session as AgentSessionLike & { state: { tools: ToolLike[] } }).state?.tools ?? [];
      const toolHub = tools.find((tool) => tool.name === "tool_hub");
      assert.ok(toolHub, "tool_hub should be available");

      const result = (await toolHub!.execute("tool-call-1", {})) as {
        details?: ToolHubResult & {
          data?: { providers?: Array<{ name?: string }> };
        };
      };
      assert.equal(result.details?.ok, true);
      if (result.details?.ok) {
        const providers = (result.details.data as { providers?: Array<{ name?: string }> })
          ?.providers;
        assert.equal(providers?.some((provider) => provider.name === "slack") ?? false, true);
      }
      session.dispose();
    } finally {
      if (previousDynamic === undefined) {
        delete process.env.ADJUTANT_DYNAMIC_TOOL_ENABLED;
      } else {
        process.env.ADJUTANT_DYNAMIC_TOOL_ENABLED = previousDynamic;
      }
      if (previousSlackEnabled === undefined) {
        delete process.env.ADJUTANT_SLACK_API_ENABLED;
      } else {
        process.env.ADJUTANT_SLACK_API_ENABLED = previousSlackEnabled;
      }
      if (previousXoxc === undefined) {
        delete process.env.ADJUTANT_SLACK_XOXC_TOKEN;
      } else {
        process.env.ADJUTANT_SLACK_XOXC_TOKEN = previousXoxc;
      }
      if (previousXoxd === undefined) {
        delete process.env.ADJUTANT_SLACK_XOXD_TOKEN;
      } else {
        process.env.ADJUTANT_SLACK_XOXD_TOKEN = previousXoxd;
      }
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("デフォルトでは tool_hub が登録される", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "adjutant-tool-hub-enabled-"));
    const previous = process.env.ADJUTANT_DYNAMIC_TOOL_ENABLED;
    process.env.ADJUTANT_DYNAMIC_TOOL_ENABLED = "1";
    configureSandbox(null);
    try {
      const session = await createTestSession(workspaceDir);
      const tools =
        (session as AgentSessionLike & { state: { tools: ToolLike[] } }).state?.tools ?? [];
      const toolHub = tools.find((tool) => tool.name === "tool_hub");
      assert.ok(toolHub, "tool_hub should be available");

      const result = (await toolHub!.execute("tool-call-1", {})) as {
        details?: ToolHubResult;
      };
      assert.equal(result.details?.ok, true);
      if (result.details?.ok) {
        assert.equal(result.details.mode, "catalog");
      }
      session.dispose();
    } finally {
      if (previous === undefined) {
        delete process.env.ADJUTANT_DYNAMIC_TOOL_ENABLED;
      } else {
        process.env.ADJUTANT_DYNAMIC_TOOL_ENABLED = previous;
      }
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("ADJUTANT_DYNAMIC_TOOL_ENABLED=0 のとき tool_hub は登録されない", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "adjutant-tool-hub-disabled-"));
    const previous = process.env.ADJUTANT_DYNAMIC_TOOL_ENABLED;
    process.env.ADJUTANT_DYNAMIC_TOOL_ENABLED = "0";
    configureSandbox(null);
    try {
      const session = await createTestSession(workspaceDir);
      const toolNames = getToolNames(session);
      assert.equal(toolNames.includes("tool_hub"), false);
      session.dispose();
    } finally {
      if (previous === undefined) {
        delete process.env.ADJUTANT_DYNAMIC_TOOL_ENABLED;
      } else {
        process.env.ADJUTANT_DYNAMIC_TOOL_ENABLED = previous;
      }
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("ADJUTANT_SLACK_API_ENABLED=0 のとき slack provider は catalog から除外される", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "adjutant-tool-hub-slack-disabled-"));
    const previousDynamic = process.env.ADJUTANT_DYNAMIC_TOOL_ENABLED;
    const previousSlackEnabled = process.env.ADJUTANT_SLACK_API_ENABLED;
    process.env.ADJUTANT_DYNAMIC_TOOL_ENABLED = "1";
    process.env.ADJUTANT_SLACK_API_ENABLED = "0";
    configureSandbox(null);
    try {
      const session = await createTestSession(workspaceDir);
      const tools =
        (session as AgentSessionLike & { state: { tools: ToolLike[] } }).state?.tools ?? [];
      const toolHub = tools.find((tool) => tool.name === "tool_hub");
      assert.ok(toolHub, "tool_hub should be available");

      const result = (await toolHub!.execute("tool-call-slack-disabled", {})) as {
        details?: ToolHubResult & {
          data?: { providers?: Array<{ name?: string }> };
        };
      };
      assert.equal(result.details?.ok, true);
      if (result.details?.ok) {
        const providers = (result.details.data as { providers?: Array<{ name?: string }> })
          ?.providers;
        assert.equal(providers?.some((provider) => provider.name === "slack") ?? false, false);
      }
      session.dispose();
    } finally {
      if (previousDynamic === undefined) {
        delete process.env.ADJUTANT_DYNAMIC_TOOL_ENABLED;
      } else {
        process.env.ADJUTANT_DYNAMIC_TOOL_ENABLED = previousDynamic;
      }
      if (previousSlackEnabled === undefined) {
        delete process.env.ADJUTANT_SLACK_API_ENABLED;
      } else {
        process.env.ADJUTANT_SLACK_API_ENABLED = previousSlackEnabled;
      }
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
