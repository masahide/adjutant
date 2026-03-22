import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest, { type TestContext } from "node:test";

import { createGuardrailExtension } from "../../src/assistant/guardrail-extension.js";
import { PermissionGateway } from "../../src/control-plane/acp/permission-gateway.js";
import { handlePermissionRequest } from "../../src/control-plane/acp/permission-request-handler.js";
import { resolveGuardrailWorkspaceScopeKey } from "../../src/guardrails/config.js";
import { GuardrailPolicyStore } from "../../src/guardrails/policy-store.js";
import {
  clearGuardrailPromptContext,
  configureGuardrailPermissionRequester,
  setGuardrailPromptContext,
} from "../../src/guardrails/worker-runtime.js";

const TEST_TIMEOUT_MS = 30_000;

const test = (name: string, fn: (t: TestContext) => Promise<void> | void): void => {
  nodeTest(name, { timeout: TEST_TIMEOUT_MS }, fn);
};

type ToolCallHandler = (event: {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}) => Promise<unknown>;

function collectToolCallHandler(input: {
  sessionId: string;
  mode: "audit" | "enforce";
  stateDir: string;
}): ToolCallHandler {
  let handler: ToolCallHandler | undefined;
  createGuardrailExtension(input)({
    on: (event: string, nextHandler: unknown) => {
      if (event === "tool_call") {
        handler = nextHandler as ToolCallHandler;
      }
    },
  } as never);
  assert.ok(handler);
  return handler;
}

test("Guardrail integration: audit mode records tool_hub action-specific decisions without blocking", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-guardrail-audit-int-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const handler = collectToolCallHandler({
    sessionId: "sess_audit",
    mode: "audit",
    stateDir,
  });

  const memoryWrite = await handler({
    toolCallId: "tool_memory_write",
    toolName: "tool_hub",
    input: {
      provider: "memory",
      action: "write",
      args: {
        content: "hello",
      },
    },
  });
  const slackSearch = await handler({
    toolCallId: "tool_slack_search",
    toolName: "tool_hub",
    input: {
      provider: "slack",
      action: "search",
      args: {
        mode: "search",
        query: "from:me",
      },
    },
  });

  assert.equal(memoryWrite, undefined);
  assert.equal(slackSearch, undefined);

  const auditLog = await readFile(join(stateDir, "guardrails", "audit.jsonl"), "utf8");
  assert.match(auditLog, /"toolCallId":"tool_memory_write"/);
  assert.match(auditLog, /"ruleId":"review-toolhub-memory-write"/);
  assert.match(auditLog, /"toolCallId":"tool_slack_search"/);
  assert.match(auditLog, /"ruleId":"review-toolhub-slack-actions"/);
});

test("Guardrail integration: allow_always persists policy and next run auto-allows reviewed tool", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-guardrail-policy-int-"));
  const workspaceScopeKey = resolveGuardrailWorkspaceScopeKey({
    stateDir,
  });
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const policyStore = GuardrailPolicyStore.fromStateDir(stateDir);
  const permissionGateway = new PermissionGateway();
  const pending = handlePermissionRequest(
    {
      sessionId: "sess_policy",
      toolCall: {
        toolCallId: "tool_policy",
        title: "tool_hub",
      },
      options: [
        { optionId: "allow_once", name: "Approve", kind: "allow_once" },
        { optionId: "allow_always", name: "Always Approve", kind: "allow_always" },
        { optionId: "reject_once", name: "Deny", kind: "reject_once" },
        { optionId: "reject_always", name: "Always Deny", kind: "reject_always" },
      ],
      _meta: {
        guardrail: {
          title: "tool_hub slack/search requires approval",
          reason: "slack action requires approval",
          ruleId: "review-toolhub-slack-actions",
          workspaceScopeKey,
          policyCandidate: {
            toolName: "tool_hub",
            toolHubMode: "execute",
            toolHubProvider: "slack",
            toolHubAction: "search",
          },
        },
      },
    },
    {
      permissionGateway,
      policyStore,
    }
  );

  permissionGateway.resolvePermission("tool_policy", "allow_always");
  const response = await pending;
  assert.deepEqual(response, {
    outcome: {
      outcome: "selected",
      optionId: "allow_always",
    },
  });

  const policies = await policyStore.listPolicies();
  assert.equal(policies.length, 1);

  const handler = collectToolCallHandler({
    sessionId: "sess_policy",
    mode: "enforce",
    stateDir,
  });
  const originalRequester = configureGuardrailPermissionRequester;
  configureGuardrailPermissionRequester(null);
  setGuardrailPromptContext({
    sessionId: "sess_policy",
    runId: "run_policy",
    sessionKey: "main",
  });
  try {
    const result = await handler({
      toolCallId: "tool_policy_next",
      toolName: "tool_hub",
      input: {
        provider: "slack",
        action: "search",
        args: {
          mode: "search",
          query: "from:me",
        },
      },
    });
    assert.equal(result, undefined);
  } finally {
    clearGuardrailPromptContext("sess_policy");
    configureGuardrailPermissionRequester(null);
    void originalRequester;
  }
});

test("Guardrail integration: timeout resolution and advisory fallback stay fail-safe", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "adjutant-guardrail-timeout-int-"));
  const workspaceScopeKey = resolveGuardrailWorkspaceScopeKey({
    stateDir,
  });
  const previous = {
    enabled: process.env.ADJUTANT_GUARDRAIL_LLM_ENABLED,
    key: process.env.OPENAI_API_KEY,
    timeout: process.env.ADJUTANT_GUARDRAIL_PERMISSION_TIMEOUT_MS,
    outcome: process.env.ADJUTANT_GUARDRAIL_TIMEOUT_OUTCOME,
  };
  t.after(async () => {
    if (previous.enabled === undefined) {
      delete process.env.ADJUTANT_GUARDRAIL_LLM_ENABLED;
    } else {
      process.env.ADJUTANT_GUARDRAIL_LLM_ENABLED = previous.enabled;
    }
    if (previous.key === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previous.key;
    }
    if (previous.timeout === undefined) {
      delete process.env.ADJUTANT_GUARDRAIL_PERMISSION_TIMEOUT_MS;
    } else {
      process.env.ADJUTANT_GUARDRAIL_PERMISSION_TIMEOUT_MS = previous.timeout;
    }
    if (previous.outcome === undefined) {
      delete process.env.ADJUTANT_GUARDRAIL_TIMEOUT_OUTCOME;
    } else {
      process.env.ADJUTANT_GUARDRAIL_TIMEOUT_OUTCOME = previous.outcome;
    }
    await rm(stateDir, { recursive: true, force: true });
  });

  process.env.ADJUTANT_GUARDRAIL_LLM_ENABLED = "1";
  delete process.env.OPENAI_API_KEY;
  process.env.ADJUTANT_GUARDRAIL_PERMISSION_TIMEOUT_MS = "5";
  process.env.ADJUTANT_GUARDRAIL_TIMEOUT_OUTCOME = "deny";

  const handler = collectToolCallHandler({
    sessionId: "sess_timeout",
    mode: "enforce",
    stateDir,
  });
  const permissionGateway = new PermissionGateway({
    defaultTimeoutMs: 5,
    defaultTimeoutSelection: "reject_once",
  });
  configureGuardrailPermissionRequester(async (input) => {
    const response = await handlePermissionRequest(
      {
        sessionId: input.sessionId,
        toolCall: {
          toolCallId: input.toolCallId,
          title: input.toolName,
        },
        options: [
          { optionId: "allow_once", name: "Approve", kind: "allow_once" },
          { optionId: "allow_always", name: "Always Approve", kind: "allow_always" },
          { optionId: "reject_once", name: "Deny", kind: "reject_once" },
          { optionId: "reject_always", name: "Always Deny", kind: "reject_always" },
        ],
        _meta: {
          guardrail: {
            title: input.title,
            reason: input.reason,
            ruleId: input.ruleId,
            workspaceScopeKey,
            policyCandidate: input.policyCandidate,
          },
        },
      },
      {
        permissionGateway,
      }
    );
    if (response.outcome.outcome === "cancelled") {
      return "cancelled";
    }
    return response.outcome.optionId === "allow_once" ||
      response.outcome.optionId === "allow_always"
      ? "allow"
      : "deny";
  });
  setGuardrailPromptContext({
    sessionId: "sess_timeout",
    runId: "run_timeout",
    sessionKey: "main",
  });

  try {
    const result = await handler({
      toolCallId: "tool_timeout",
      toolName: "write",
      input: {
        path: "tmp.txt",
        content: "hello",
      },
    });
    assert.deepEqual(result, {
      block: true,
      reason: "[guardrail:review-side-effecting-tools] tool execution denied by user review",
    });
  } finally {
    clearGuardrailPromptContext("sess_timeout");
    configureGuardrailPermissionRequester(null);
  }
});
