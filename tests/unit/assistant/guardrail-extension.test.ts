import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function createStateDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

test("guardrail extension blocks forbidden commands before execution", async (t) => {
  let handler: ToolCallHandler | undefined;
  const stateDir = await createStateDir("adjutant-guardrail-enforce-");
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  createGuardrailExtension({ sessionId: "sess_1", mode: "enforce", stateDir })({
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

test("guardrail extension requests human review for reviewed tools", async (t) => {
  let handler: ToolCallHandler | undefined;
  const stateDir = await createStateDir("adjutant-guardrail-review-");
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  createGuardrailExtension({ sessionId: "sess_review", mode: "enforce", stateDir })({
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

test("guardrail extension records audit in audit mode and does not block", async (t) => {
  let handler: ToolCallHandler | undefined;
  const stateDir = await createStateDir("adjutant-guardrail-audit-");
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  createGuardrailExtension({ sessionId: "sess_audit", mode: "audit", stateDir })({
    on: (event: string, nextHandler: unknown) => {
      if (event === "tool_call") {
        handler = nextHandler as typeof handler;
      }
    },
  } as never);

  assert.ok(handler);

  const result = await handler({
    toolCallId: "tool_3",
    toolName: "write",
    input: {
      path: "tmp.txt",
      content: "hello",
    },
  });

  assert.equal(result, undefined);
  const auditPath = join(stateDir, "guardrails", "audit.jsonl");
  const payload = await readFile(auditPath, "utf8");
  assert.match(payload, /"decision":"review"/);
  assert.match(payload, /"toolName":"write"/);
});

test("guardrail extension emits warnings when policy/audit stores fail", async (t) => {
  let handler: ToolCallHandler | undefined;
  const stateDir = await createStateDir("adjutant-guardrail-warn-");
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "guardrails"), "not-a-directory", "utf8");

  createGuardrailExtension({
    sessionId: "sess_warn",
    mode: "audit",
    stateDir,
    onWarn: (message, meta) => {
      warnings.push({ message, meta });
    },
  })({
    on: (event: string, nextHandler: unknown) => {
      if (event === "tool_call") {
        handler = nextHandler as typeof handler;
      }
    },
  } as never);

  assert.ok(handler);

  const result = await handler({
    toolCallId: "tool_warn",
    toolName: "read",
    input: {
      path: "README.md",
    },
  });

  assert.equal(result, undefined);
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0]?.message, "failed to load guardrail policy store");
  assert.equal(warnings[1]?.message, "failed to append guardrail audit record");
  assert.equal(warnings[0]?.meta?.sessionId, "sess_warn");
  assert.equal(warnings[1]?.meta?.sessionId, "sess_warn");
});
