import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resetAgentRunnerForTest,
  runAgent,
  setAgentRunnerRuntimeForTest,
} from "../../src/assistant/agent-runner.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function inMemorySessionStoreRuntime() {
  const store: Record<string, Record<string, unknown>> = {};
  return {
    loadSessionEntryStore: async () => ({ path: "/tmp/none", store }),
    saveSessionEntryStore: async () => "/tmp/none",
    repairSessionData: async () => false,
  };
}

describe("AgentRunner", () => {
  afterEach(() => {
    resetAgentRunnerForTest();
  });

  it("SDK 利用手順 lock -> open -> create -> subscribe -> dispose を守る", async () => {
    const steps: string[] = [];
    let listener: ((event: unknown) => void) | undefined;

    setAgentRunnerRuntimeForTest({
      ...inMemorySessionStoreRuntime(),
      nowMs: () => 1000,
      acquireLock: async () => {
        steps.push("lock");
        return () => {
          steps.push("unlock");
        };
      },
      openSessionManager: () => {
        steps.push("open");
        return {};
      },
      createSession: async () => {
        steps.push("create");
        return {
          session: {
            subscribe: (cb) => {
              steps.push("subscribe");
              listener = cb;
              return () => {
                steps.push("unsubscribe");
              };
            },
            prompt: async () => {
              listener?.({
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: "ok" },
              });
            },
            dispose: () => {
              steps.push("dispose");
            },
          },
        };
      },
    });

    const result = await runAgent({
      runId: "run-01",
      prompt: "hello",
      sessionKey: "main",
    });

    assert.equal(result.runId, "run-01");
    assert.deepEqual(steps, [
      "lock",
      "open",
      "create",
      "subscribe",
      "unsubscribe",
      "dispose",
      "unlock",
    ]);
  });

  it("onTextDelta / onToolCall コールバックへイベントを転送する", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const deltas: string[] = [];
    const toolCalls: Array<{ name: string; args: unknown }> = [];
    let nowTick = 0;

    setAgentRunnerRuntimeForTest({
      ...inMemorySessionStoreRuntime(),
      nowMs: () => {
        nowTick += 100;
        return nowTick;
      },
      acquireLock: async () => () => undefined,
      openSessionManager: () => ({}),
      createSession: async () => ({
        session: {
          subscribe: (cb) => {
            listener = cb;
            return () => undefined;
          },
          prompt: async () => {
            listener?.({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: "Hello " },
            });
            listener?.({
              type: "tool_execution_start",
              toolName: "memory_write",
              args: { scope: "daily", content: "remember" },
            });
            listener?.({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: "World" },
            });
          },
          dispose: () => undefined,
        },
      }),
    });

    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-agent-`);
    try {
      const result = await runAgent({
        runId: "run-02",
        prompt: "これ覚えておいて",
        sessionKey: "main",
        workspaceDir: tempDir,
        timezone: "UTC",
        sessionEntriesPath: join(tempDir, "sessions.json"),
        onTextDelta: (delta) => deltas.push(delta),
        onToolCall: (name, args) => toolCalls.push({ name, args }),
      });

      assert.equal(result.text, "Hello World");
      assert.equal((result.durationMs ?? 0) > 0, true);
      assert.deepEqual(deltas, ["Hello ", "World"]);
      assert.deepEqual(toolCalls, [
        { name: "memory_write", args: { scope: "daily", content: "remember" } },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("tool_execution_end は AgentRunResult.toolCalls に集約される", async () => {
    let listener: ((event: unknown) => void) | undefined;

    setAgentRunnerRuntimeForTest({
      ...inMemorySessionStoreRuntime(),
      nowMs: () => 1000,
      acquireLock: async () => () => undefined,
      openSessionManager: () => ({}),
      createSession: async () => ({
        session: {
          subscribe: (cb) => {
            listener = cb;
            return () => undefined;
          },
          prompt: async () => {
            listener?.({
              type: "tool_execution_end",
              toolName: "memory_write",
              result: { ok: true, scope: "daily" },
            });
          },
          dispose: () => undefined,
        },
      }),
    });

    const result = await runAgent({
      runId: "run-tool-calls",
      prompt: "remember this",
      sessionKey: "main",
      memoryWriteRequested: true,
    });

    assert.deepEqual(result.toolCalls, [
      { name: "memory_write", result: { ok: true, scope: "daily" } },
    ]);
  });

  it("例外時も finally で dispose と lock 解放を実行する", async () => {
    const steps: string[] = [];

    setAgentRunnerRuntimeForTest({
      ...inMemorySessionStoreRuntime(),
      nowMs: () => 0,
      acquireLock: async () => {
        steps.push("lock");
        return () => {
          steps.push("unlock");
        };
      },
      openSessionManager: () => ({}),
      createSession: async () => ({
        session: {
          subscribe: () => () => undefined,
          prompt: async () => {
            throw new Error("session failed");
          },
          dispose: () => {
            steps.push("dispose");
          },
        },
      }),
    });

    await assert.rejects(
      runAgent({
        runId: "run-03",
        prompt: "hello",
        sessionKey: "main",
      }),
      /session failed/
    );

    assert.deepEqual(steps, ["lock", "dispose", "unlock"]);
  });

  it("明示トリガーありでは memory_write が実行される", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-agent-`);
    try {
      setAgentRunnerRuntimeForTest({
        ...inMemorySessionStoreRuntime(),
        nowMs: () => 100,
        acquireLock: async () => () => undefined,
        openSessionManager: () => ({}),
        createSession: async () => ({
          session: {
            subscribe: (cb) => {
              listener = cb;
              return () => undefined;
            },
            prompt: async () => {
              listener?.({
                type: "tool_execution_start",
                toolName: "memory_write",
                args: { scope: "daily", content: "remember me" },
              });
            },
            dispose: () => undefined,
          },
        }),
      });

      await runAgent({
        runId: "run-memory-1",
        prompt: "この件を覚えておいて",
        sessionKey: "main",
        workspaceDir: tempDir,
        timezone: "UTC",
        sessionEntriesPath: join(tempDir, "sessions.json"),
      });

      const memoryDir = join(tempDir, "memory");
      const files = await readdir(memoryDir);
      assert.equal(files.length > 0, true);
      const content = await readFile(join(memoryDir, files[0] ?? ""), "utf8");
      assert.equal(content.includes("remember me"), true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("明示トリガーなしでは memory_write を実行しない", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-agent-`);
    try {
      setAgentRunnerRuntimeForTest({
        ...inMemorySessionStoreRuntime(),
        nowMs: () => 100,
        acquireLock: async () => () => undefined,
        openSessionManager: () => ({}),
        createSession: async () => ({
          session: {
            subscribe: (cb) => {
              listener = cb;
              return () => undefined;
            },
            prompt: async () => {
              listener?.({
                type: "tool_execution_start",
                toolName: "memory_write",
                args: { scope: "daily", content: "should not write" },
              });
            },
            dispose: () => undefined,
          },
        }),
      });

      await runAgent({
        runId: "run-memory-2",
        prompt: "こんにちは",
        sessionKey: "main",
        workspaceDir: tempDir,
        timezone: "UTC",
        sessionEntriesPath: join(tempDir, "sessions.json"),
      });

      const memoryDir = join(tempDir, "memory");
      assert.equal(await pathExists(memoryDir), false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("isHeartbeat=true では memory_write を実行しない", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-agent-`);
    try {
      setAgentRunnerRuntimeForTest({
        ...inMemorySessionStoreRuntime(),
        nowMs: () => 100,
        acquireLock: async () => () => undefined,
        openSessionManager: () => ({}),
        createSession: async () => ({
          session: {
            subscribe: (cb) => {
              listener = cb;
              return () => undefined;
            },
            prompt: async () => {
              listener?.({
                type: "tool_execution_start",
                toolName: "memory_write",
                args: { scope: "daily", content: "should not write" },
              });
            },
            dispose: () => undefined,
          },
        }),
      });

      await runAgent({
        runId: "run-memory-3",
        prompt: "この件を覚えておいて",
        sessionKey: "main",
        isHeartbeat: true,
        workspaceDir: tempDir,
        timezone: "UTC",
        sessionEntriesPath: join(tempDir, "sessions.json"),
      });

      const memoryDir = join(tempDir, "memory");
      assert.equal(await pathExists(memoryDir), false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("memory_write 保存内容は次回ターンの入力へ再注入される", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-agent-`);
    let listener: ((event: unknown) => void) | undefined;
    const prompts: string[] = [];

    try {
      setAgentRunnerRuntimeForTest({
        ...inMemorySessionStoreRuntime(),
        nowMs: () => 100,
        acquireLock: async () => () => undefined,
        openSessionManager: () => ({}),
        createSession: async () => ({
          session: {
            subscribe: (cb) => {
              listener = cb;
              return () => undefined;
            },
            prompt: async (text) => {
              prompts.push(text);
              if (prompts.length === 1) {
                listener?.({
                  type: "tool_execution_start",
                  toolName: "memory_write",
                  args: { scope: "daily", content: "daily-memory-note" },
                });
              }
            },
            dispose: () => undefined,
          },
        }),
      });

      await runAgent({
        runId: "run-memory-4a",
        prompt: "これ覚えておいて",
        sessionKey: "main",
        workspaceDir: tempDir,
        timezone: "UTC",
        sessionEntriesPath: join(tempDir, "sessions.json"),
      });
      await runAgent({
        runId: "run-memory-4b",
        prompt: "前回の内容を教えて",
        sessionKey: "main",
        workspaceDir: tempDir,
        timezone: "UTC",
        sessionEntriesPath: join(tempDir, "sessions.json"),
      });

      assert.equal(prompts.length >= 2, true);
      assert.equal(prompts[1]?.includes("daily-memory-note"), true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("ハートビート実行後に updatedAt は Math.max で復元される", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-agent-`);
    const sessionEntriesPath = join(tempDir, "sessions.json");
    await writeFile(
      sessionEntriesPath,
      JSON.stringify({
        main: {
          sessionId: "s-main",
          updatedAt: "2030-01-01T00:00:00.000Z",
        },
      }),
      "utf8"
    );

    try {
      setAgentRunnerRuntimeForTest({
        nowMs: () => 1000,
        acquireLock: async () => () => undefined,
        openSessionManager: () => ({}),
        createSession: async () => ({
          session: {
            subscribe: () => () => undefined,
            prompt: async () => undefined,
            dispose: () => undefined,
          },
        }),
      });

      await runAgent({
        runId: "run-hb-updatedAt",
        prompt: "heartbeat",
        sessionKey: "main",
        isHeartbeat: true,
        sessionEntriesPath,
      });

      const updated = JSON.parse(await readFile(sessionEntriesPath, "utf8")) as {
        main?: { updatedAt?: string };
      };
      assert.equal(updated.main?.updatedAt, "2030-01-01T00:00:00.000Z");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("一時エラー時は 2.5 秒待機して 1 回再試行する", async () => {
    let calls = 0;
    const waits: number[] = [];

    setAgentRunnerRuntimeForTest({
      ...inMemorySessionStoreRuntime(),
      nowMs: () => 1000 + calls,
      wait: async (ms) => {
        waits.push(ms);
      },
      acquireLock: async () => () => undefined,
      openSessionManager: () => ({}),
      createSession: async () => ({
        session: {
          subscribe: () => () => undefined,
          prompt: async () => {
            calls += 1;
            if (calls === 1) {
              throw new Error("temporary timeout");
            }
          },
          dispose: () => undefined,
        },
      }),
    });

    const result = await runAgent({
      runId: "run-retry-transient",
      prompt: "hello",
      sessionKey: "main",
    });

    assert.equal(result.runId, "run-retry-transient");
    assert.equal(calls, 2);
    assert.deepEqual(waits, [2500]);
  });

  it("コンテキスト超過時は入力を切り詰めて 1 回再試行する", async () => {
    let calls = 0;
    const prompts: string[] = [];

    setAgentRunnerRuntimeForTest({
      ...inMemorySessionStoreRuntime(),
      nowMs: () => 1000 + calls,
      acquireLock: async () => () => undefined,
      openSessionManager: () => ({}),
      createSession: async () => ({
        session: {
          subscribe: () => () => undefined,
          prompt: async (text) => {
            prompts.push(text);
            calls += 1;
            if (calls === 1) {
              throw new Error("context window too long");
            }
          },
          dispose: () => undefined,
        },
      }),
    });

    await runAgent({
      runId: "run-retry-context",
      prompt: "x".repeat(1200),
      sessionKey: "main",
    });

    assert.equal(calls, 2);
    assert.equal(prompts.length, 2);
    assert.equal((prompts[1]?.length ?? 0) < (prompts[0]?.length ?? 0), true);
  });

  it("モデル利用不可は即座に失敗する", async () => {
    let createSessionCalled = false;

    setAgentRunnerRuntimeForTest({
      ...inMemorySessionStoreRuntime(),
      isModelAvailable: () => false,
      createSession: async () => {
        createSessionCalled = true;
        return {
          session: {
            subscribe: () => () => undefined,
            prompt: async () => undefined,
            dispose: () => undefined,
          },
        };
      },
    });

    await assert.rejects(
      runAgent({
        runId: "run-model-unavailable",
        prompt: "hello",
        sessionKey: "main",
        model: "gpt-unavailable",
      }),
      /model unavailable/
    );
    assert.equal(createSessionCalled, false);
  });

  it("セッション破損エラー時は修復を試行して再生成する", async () => {
    let createCalls = 0;
    let repaired = false;

    setAgentRunnerRuntimeForTest({
      ...inMemorySessionStoreRuntime(),
      acquireLock: async () => () => undefined,
      openSessionManager: () => ({}),
      repairSessionData: async () => {
        repaired = true;
        return true;
      },
      createSession: async () => {
        createCalls += 1;
        if (createCalls === 1) {
          throw new Error("session json parse error");
        }
        return {
          session: {
            subscribe: () => () => undefined,
            prompt: async () => undefined,
            dispose: () => undefined,
          },
        };
      },
    });

    const result = await runAgent({
      runId: "run-session-repair",
      prompt: "hello",
      sessionKey: "main",
    });

    assert.equal(result.runId, "run-session-repair");
    assert.equal(repaired, true);
    assert.equal(createCalls, 2);
  });

  it("sessions.json 単位で排他され、異なる sessionKey の並行更新でも欠落しない", async () => {
    const persisted: Record<string, Record<string, unknown>> = {};

    setAgentRunnerRuntimeForTest({
      nowMs: (() => {
        let tick = 0;
        return () => {
          tick += 1;
          return 1700000000000 + tick;
        };
      })(),
      readMemoryFiles: async () => ({ longTerm: null, daily: null, yesterday: null }),
      loadSessionEntryStore: async () => ({
        path: "/tmp/adjutant-sessions.json",
        store: structuredClone(persisted),
      }),
      saveSessionEntryStore: async (store) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        for (const key of Object.keys(persisted)) {
          delete persisted[key];
        }
        Object.assign(persisted, structuredClone(store));
        return "/tmp/adjutant-sessions.json";
      },
      openSessionManager: () => ({}),
      createSession: async () => ({
        session: {
          subscribe: () => () => undefined,
          prompt: async (text) => {
            const delayMs = text.includes("session:a") ? 30 : 5;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          },
          dispose: () => undefined,
        },
      }),
    });

    await Promise.all([
      runAgent({
        runId: "run-a",
        prompt: "update session:a",
        sessionKey: "session:a",
        sessionEntriesPath: "/tmp/adjutant-sessions.json",
      }),
      runAgent({
        runId: "run-b",
        prompt: "update session:b",
        sessionKey: "session:b",
        sessionEntriesPath: "/tmp/adjutant-sessions.json",
      }),
    ]);

    assert.equal(typeof persisted["session:a"]?.updatedAt, "string");
    assert.equal(typeof persisted["session:b"]?.updatedAt, "string");
  });

  it("デフォルト実装は永続 SessionManager を使い、sessionId/sessionFile を保存する", async () => {
    const tempDir = await mkdtemp(`${tmpdir()}/adjutant-agent-`);
    const sessionEntriesPath = join(tempDir, "sessions.json");
    let persistedSessionManager = false;

    try {
      setAgentRunnerRuntimeForTest({
        nowMs: () => 1000,
        createSession: async (params) => {
          const maybeManager = params.sessionManager as { isPersisted?: () => boolean };
          persistedSessionManager = maybeManager.isPersisted?.() ?? false;
          return {
            session: {
              sessionId: "session-main-001",
              sessionFile: join(tempDir, "sessions", "session-main-001.jsonl"),
              subscribe: () => () => undefined,
              prompt: async () => undefined,
              dispose: () => undefined,
            },
          };
        },
      });

      const result = await runAgent({
        runId: "run-persisted-session",
        prompt: "こんにちは",
        sessionKey: "main",
        sessionEntriesPath,
      });

      assert.equal(persistedSessionManager, true);
      assert.equal(result.sessionId, "session-main-001");

      const saved = JSON.parse(await readFile(sessionEntriesPath, "utf8")) as {
        main?: { sessionId?: string; sessionFile?: string };
      };
      assert.equal(saved.main?.sessionId, "session-main-001");
      assert.equal(saved.main?.sessionFile, "sessions/session-main-001.jsonl");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("createSession へ model/isHeartbeat/memoryWriteEnabled を渡す", async () => {
    let captured:
      | {
          model?: string;
          isHeartbeat?: boolean;
          memoryWriteEnabled?: boolean;
        }
      | undefined;

    setAgentRunnerRuntimeForTest({
      ...inMemorySessionStoreRuntime(),
      nowMs: () => 1000,
      acquireLock: async () => () => undefined,
      openSessionManager: () => ({}),
      createSession: async (params) => {
        captured = {
          model: params.model,
          isHeartbeat: params.isHeartbeat,
          memoryWriteEnabled: params.memoryWriteEnabled,
        };
        return {
          session: {
            subscribe: () => () => undefined,
            prompt: async () => undefined,
            dispose: () => undefined,
          },
        };
      },
    });

    await runAgent({
      runId: "run-propagation",
      prompt: "この件を覚えておいて",
      sessionKey: "main",
      model: "openai/gpt-5.1-codex",
      isHeartbeat: true,
    });

    assert.deepEqual(captured, {
      model: "openai/gpt-5.1-codex",
      isHeartbeat: true,
      memoryWriteEnabled: false,
    });
  });

  it("spoke セッションでは memory をロードしない", async () => {
    let readMemoryCalls = 0;
    let capturedPrompt = "";

    setAgentRunnerRuntimeForTest({
      ...inMemorySessionStoreRuntime(),
      nowMs: () => 1000,
      acquireLock: async () => () => undefined,
      readMemoryFiles: async () => {
        readMemoryCalls += 1;
        return { longTerm: "long-term", daily: "daily", yesterday: null };
      },
      openSessionManager: () => ({}),
      createSession: async () => ({
        session: {
          subscribe: () => () => undefined,
          prompt: async (prompt) => {
            capturedPrompt = prompt;
          },
          dispose: () => undefined,
        },
      }),
    });

    await runAgent({
      runId: "run-spoke-memory",
      prompt: "hello",
      sessionKey: "slack:channel:C1",
    });

    assert.equal(readMemoryCalls, 0);
    assert.equal(capturedPrompt.includes("## Memory"), false);
    assert.equal(capturedPrompt.includes("## Daily Memory"), false);
  });

  it("main セッションでは memory をロードして prompt に注入する", async () => {
    let readMemoryCalls = 0;
    let capturedPrompt = "";

    setAgentRunnerRuntimeForTest({
      ...inMemorySessionStoreRuntime(),
      nowMs: () => 1000,
      acquireLock: async () => () => undefined,
      readMemoryFiles: async () => {
        readMemoryCalls += 1;
        return { longTerm: "LT", daily: "DY", yesterday: null };
      },
      openSessionManager: () => ({}),
      createSession: async () => ({
        session: {
          subscribe: () => () => undefined,
          prompt: async (prompt) => {
            capturedPrompt = prompt;
          },
          dispose: () => undefined,
        },
      }),
    });

    await runAgent({
      runId: "run-main-memory",
      prompt: "hello",
      sessionKey: "main",
    });

    assert.equal(readMemoryCalls, 1);
    assert.equal(capturedPrompt.includes("## Memory\nLT"), true);
    assert.equal(capturedPrompt.includes("## Daily Memory\nDY"), true);
  });

  it("createSession へ memoryScope(main/spoke) を渡す", async () => {
    const scopes: Array<"main" | "spoke" | undefined> = [];

    setAgentRunnerRuntimeForTest({
      ...inMemorySessionStoreRuntime(),
      nowMs: () => 1000,
      acquireLock: async () => () => undefined,
      openSessionManager: () => ({}),
      createSession: async (params) => {
        scopes.push(params.memoryScope);
        return {
          session: {
            subscribe: () => () => undefined,
            prompt: async () => undefined,
            dispose: () => undefined,
          },
        };
      },
    });

    await runAgent({
      runId: "run-memory-scope-main",
      prompt: "hello",
      sessionKey: "main",
    });
    await runAgent({
      runId: "run-memory-scope-spoke",
      prompt: "hello",
      sessionKey: "slack:channel:C100",
    });

    assert.deepEqual(scopes, ["main", "spoke"]);
  });
});
