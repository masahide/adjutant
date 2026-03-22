import assert from "node:assert/strict";
import test from "node:test";

import { createGuardrailExtension } from "../../../src/assistant/guardrail-extension.js";
import {
  clearGuardrailPromptContext,
  configureGuardrailPermissionRequester,
  setGuardrailPromptContext,
} from "../../../src/guardrails/worker-runtime.js";

type ToolCallHandler = (event: {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}) => Promise<unknown>;

test("guardrail extension blocks forbidden commands before execution", async () => {
  let handler: ToolCallHandler | undefined;

  createGuardrailExtension({ sessionId: "sess_1" })({
    on: (event: string, nextHandler: unknown) => {
      if (event === "tool_call") {
        handler = nextHandler as typeof handler;
      }
    },
  } as never);

  assert.ok(handler);

  const result = await handler({
    toolCallId: "tool_1",
    toolName: "bash",
    input: {
      command: "sudo whoami",
    },
  });

  assert.deepEqual(result, {
    block: true,
    reason:
      "[guardrail:forbid-bash-policy-escalation] sandbox 境界の外側を狙うコマンドはガードレールで拒否します。",
  });
});

test("guardrail extension requests human review for reviewed tools", async () => {
  let handler: ToolCallHandler | undefined;

  createGuardrailExtension({ sessionId: "sess_review" })({
    on: (event: string, nextHandler: unknown) => {
      if (event === "tool_call") {
        handler = nextHandler as typeof handler;
      }
    },
  } as never);

  assert.ok(handler);

  setGuardrailPromptContext({
    sessionId: "sess_review",
    runId: "run_1",
    sessionKey: "main",
  });
  configureGuardrailPermissionRequester(async () => "deny");

  try {
    const result = await handler({
      toolCallId: "tool_2",
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
    clearGuardrailPromptContext("sess_review");
    configureGuardrailPermissionRequester(null);
  }
});
