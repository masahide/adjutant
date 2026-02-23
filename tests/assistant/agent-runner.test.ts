import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import {
  resetAgentRunnerForTest,
  runAgent,
  setAgentRunnerRuntimeForTest,
} from "../../src/assistant/agent-runner.js";
import { DEFAULT_MEMORY_FLUSH_PROMPT } from "../../src/assistant/compaction-runtime.js";

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

async function withEnv(vars: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
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

  it("正常完了時は onTerminalRecord に assistant_final を通知する", async () => {
    const terminals: Array<{ actionType: string; runId: string; sessionKey: string }> = [];

    setAgentRunnerRuntimeForTest({
      ...inMemorySessionStoreRuntime(),
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
      runId: "run-terminal-final",
      prompt: "hello",
      sessionKey: "main",
      onTerminalRecord: (input) => {
        terminals.push({
          actionType: input.actionType,
          runId: input.runId,
          sessionKey: input.sessionKey,
        });
      },
    });

    assert.deepEqual(terminals, [
      {
        actionType: "assistant_final",
        runId: "run-terminal-final",
        sessionKey: "main",
      },
    ]);
  });

  it("失敗時は onTerminalRecord に assistant_error を通知する", async () => {
    const terminals: string[] = [];

    setAgentRunnerRuntimeForTest({
      ...inMemorySessionStoreRuntime(),
      nowMs: () => 1000,
      acquireLock: async () => () => undefined,
      openSessionManager: () => ({}),
      createSession: async () => ({
        session: {
          subscribe: () => () => undefined,
          prompt: async () => {
            throw new Error("boom");
          },
          dispose: () => undefined,
        },
      }),
    });

    await assert.rejects(
      runAgent({
        runId: "run-terminal-error",
        prompt: "hello",
        sessionKey: "main",
        onTerminalRecord: (input) => {
          terminals.push(input.actionType);
        },
      })
    );

    assert.deepEqual(terminals, ["assistant_error"]);
  });

  it("isAborted が true の場合は onTerminalRecord に assistant_aborted を通知する", async () => {
    const terminals: string[] = [];

    setAgentRunnerRuntimeForTest({
      ...inMemorySessionStoreRuntime(),
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
      runId: "run-terminal-aborted",
      prompt: "hello",
      sessionKey: "main",
      isAborted: () => true,
      onTerminalRecord: (input) => {
        terminals.push(input.actionType);
      },
    });

    assert.deepEqual(terminals, ["assistant_aborted"]);
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

  it("isHeartbeat=true では sendCustomMessage で heartbeat メッセージを送信する", async () => {
    const prompts: string[] = [];
    const customMessages: Array<{
      message: {
        customType: string;
        content: string | Array<{ type: string; text?: string }>;
        display: boolean;
        details?: unknown;
      };
      options?: { triggerTurn?: boolean };
    }> = [];

    setAgentRunnerRuntimeForTest({
      ...inMemorySessionStoreRuntime(),
      nowMs: () => 1000,
      acquireLock: async () => () => undefined,
      openSessionManager: () => ({}),
      createSession: async () => ({
        session: {
          subscribe: () => () => undefined,
          prompt: async (text) => {
            prompts.push(text);
          },
          sendCustomMessage: async (message, options) => {
            customMessages.push({ message, options });
          },
          dispose: () => undefined,
        },
      }),
    });

    await runAgent({
      runId: "run-heartbeat-custom-message",
      prompt: "heartbeat payload",
      sessionKey: "thread:C1",
      isHeartbeat: true,
    });

    assert.equal(prompts.length, 0);
    assert.equal(customMessages.length, 1);
    assert.equal(customMessages[0]?.message.customType, "adjutant:heartbeat");
    assert.equal(customMessages[0]?.message.display, false);
    assert.equal(customMessages[0]?.message.content, "heartbeat payload");
    assert.deepEqual(customMessages[0]?.message.details, {
      runId: "run-heartbeat-custom-message",
    });
    assert.equal(customMessages[0]?.options?.triggerTurn, true);
  });

  it("isHeartbeat=false では従来どおり prompt を使用する", async () => {
    const prompts: string[] = [];
    const customMessages: unknown[] = [];

    setAgentRunnerRuntimeForTest({
      ...inMemorySessionStoreRuntime(),
      nowMs: () => 1000,
      acquireLock: async () => () => undefined,
      openSessionManager: () => ({}),
      createSession: async () => ({
        session: {
          subscribe: () => () => undefined,
          prompt: async (text) => {
            prompts.push(text);
          },
          sendCustomMessage: async (message) => {
            customMessages.push(message);
          },
          dispose: () => undefined,
        },
      }),
    });

    await runAgent({
      runId: "run-chat-prompt",
      prompt: "hello",
      sessionKey: "thread:C1",
      isHeartbeat: false,
    });

    assert.deepEqual(prompts, ["hello"]);
    assert.equal(customMessages.length, 0);
  });

  it("sendCustomMessage がない heartbeat セッションは prompt にフォールバックする", async () => {
    const prompts: string[] = [];

    setAgentRunnerRuntimeForTest({
      ...inMemorySessionStoreRuntime(),
      nowMs: () => 1000,
      acquireLock: async () => () => undefined,
      openSessionManager: () => ({}),
      createSession: async () => ({
        session: {
          subscribe: () => () => undefined,
          prompt: async (text) => {
            prompts.push(text);
          },
          dispose: () => undefined,
        },
      }),
    });

    await runAgent({
      runId: "run-heartbeat-fallback-prompt",
      prompt: "fallback heartbeat",
      sessionKey: "thread:C1",
      isHeartbeat: true,
    });

    assert.deepEqual(prompts, ["fallback heartbeat"]);
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

  it("heartbeat の sendCustomMessage でも一時エラー時は 2.5 秒待機して 1 回再試行する", async () => {
    let sendCalls = 0;
    let promptCalls = 0;
    const waits: number[] = [];

    setAgentRunnerRuntimeForTest({
      ...inMemorySessionStoreRuntime(),
      nowMs: () => 1000 + sendCalls,
      wait: async (ms) => {
        waits.push(ms);
      },
      acquireLock: async () => () => undefined,
      openSessionManager: () => ({}),
      createSession: async () => ({
        session: {
          subscribe: () => () => undefined,
          prompt: async () => {
            promptCalls += 1;
          },
          sendCustomMessage: async () => {
            sendCalls += 1;
            if (sendCalls === 1) {
              throw new Error("temporary timeout");
            }
          },
          dispose: () => undefined,
        },
      }),
    });

    await runAgent({
      runId: "run-retry-transient-heartbeat",
      prompt: "heartbeat",
      sessionKey: "thread:C1",
      isHeartbeat: true,
    });

    assert.equal(sendCalls, 2);
    assert.equal(promptCalls, 0);
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

  it("pre-compaction memory flush は閾値超過時のみ実行される", async () => {
    await withEnv(
      {
        ADJUTANT_MEMORY_FLUSH_ENABLED: "true",
        ADJUTANT_COMPACTION_RESERVE_TOKENS_FLOOR: "10000",
        ADJUTANT_MEMORY_FLUSH_SOFT_THRESHOLD_TOKENS: "10000",
      },
      async () => {
        const promptsHigh: string[] = [];
        setAgentRunnerRuntimeForTest({
          ...inMemorySessionStoreRuntime(),
          nowMs: () => 1000,
          acquireLock: async () => () => undefined,
          openSessionManager: () => ({}),
          readMemoryFiles: async () => ({ longTerm: null, daily: null, yesterday: null }),
          createSession: async () => ({
            session: {
              subscribe: () => () => undefined,
              getContextUsage: () => ({ tokens: 80_000, contextWindow: 100_000, percent: 80 }),
              prompt: async (text) => {
                promptsHigh.push(text);
              },
              dispose: () => undefined,
            },
          }),
        });

        await runAgent({
          runId: "run-preflush-high",
          prompt: "hello",
          sessionKey: "main",
        });

        assert.equal(promptsHigh.length, 2);
        assert.equal(promptsHigh[0]?.includes(DEFAULT_MEMORY_FLUSH_PROMPT), true);
        assert.equal(promptsHigh[1], "hello");

        const promptsLow: string[] = [];
        setAgentRunnerRuntimeForTest({
          ...inMemorySessionStoreRuntime(),
          nowMs: () => 1000,
          acquireLock: async () => () => undefined,
          openSessionManager: () => ({}),
          readMemoryFiles: async () => ({ longTerm: null, daily: null, yesterday: null }),
          createSession: async () => ({
            session: {
              subscribe: () => () => undefined,
              getContextUsage: () => ({ tokens: 79_999, contextWindow: 100_000, percent: 80 }),
              prompt: async (text) => {
                promptsLow.push(text);
              },
              dispose: () => undefined,
            },
          }),
        });

        await runAgent({
          runId: "run-preflush-low",
          prompt: "hello",
          sessionKey: "main",
        });

        assert.equal(promptsLow.length, 1);
        assert.equal(promptsLow[0], "hello");
      }
    );
  });

  it("flush turn の中間出力は結果本文に混入せず memory_write は実行される", async () => {
    await withEnv(
      {
        ADJUTANT_MEMORY_FLUSH_ENABLED: "true",
        ADJUTANT_COMPACTION_RESERVE_TOKENS_FLOOR: "10000",
        ADJUTANT_MEMORY_FLUSH_SOFT_THRESHOLD_TOKENS: "10000",
      },
      async () => {
        const tempDir = await mkdtemp(`${tmpdir()}/adjutant-agent-flush-`);
        let listener: ((event: unknown) => void) | undefined;
        let promptCount = 0;
        try {
          setAgentRunnerRuntimeForTest({
            ...inMemorySessionStoreRuntime(),
            nowMs: (() => {
              let tick = 1000;
              return () => {
                tick += 1;
                return tick;
              };
            })(),
            acquireLock: async () => () => undefined,
            openSessionManager: () => ({}),
            readMemoryFiles: async () => ({ longTerm: null, daily: null, yesterday: null }),
            createSession: async () => ({
              session: {
                subscribe: (cb) => {
                  listener = cb;
                  return () => undefined;
                },
                getContextUsage: () => ({ tokens: 80_000, contextWindow: 100_000, percent: 80 }),
                prompt: async () => {
                  promptCount += 1;
                  if (promptCount === 1) {
                    listener?.({
                      type: "message_update",
                      assistantMessageEvent: { type: "text_delta", delta: "hidden-flush" },
                    });
                    listener?.({
                      type: "tool_execution_start",
                      toolName: "memory_write",
                      args: { scope: "daily", content: "flush-memory-note" },
                    });
                    return;
                  }
                  listener?.({
                    type: "message_update",
                    assistantMessageEvent: { type: "text_delta", delta: "visible-reply" },
                  });
                },
                dispose: () => undefined,
              },
            }),
          });

          const result = await runAgent({
            runId: "run-flush-silent",
            prompt: "hello",
            sessionKey: "main",
            memoryWriteRequested: true,
            workspaceDir: tempDir,
            timezone: "UTC",
          });

          assert.equal(result.text, "visible-reply");
          assert.equal(promptCount, 2);

          const memoryDir = join(tempDir, "memory");
          const files = await readdir(memoryDir);
          assert.equal(files.length > 0, true);
          const daily = await readFile(join(memoryDir, files[0] ?? ""), "utf8");
          assert.equal(daily.includes("flush-memory-note"), true);
        } finally {
          await rm(tempDir, { recursive: true, force: true });
        }
      }
    );
  });

  it("auto_compaction_end 発火で compactionCount が更新される", async () => {
    await withEnv(
      {
        ADJUTANT_MEMORY_FLUSH_ENABLED: "false",
      },
      async () => {
        const persisted: Record<string, Record<string, unknown>> = {
          main: { compactionCount: 1 },
        };
        let listener: ((event: unknown) => void) | undefined;

        setAgentRunnerRuntimeForTest({
          nowMs: () => 1000,
          acquireLock: async () => () => undefined,
          readMemoryFiles: async () => ({ longTerm: null, daily: null, yesterday: null }),
          loadSessionEntryStore: async () => ({
            path: "/tmp/adjutant-sessions.json",
            store: structuredClone(persisted),
          }),
          saveSessionEntryStore: async (store) => {
            for (const key of Object.keys(persisted)) {
              delete persisted[key];
            }
            Object.assign(persisted, structuredClone(store));
            return "/tmp/adjutant-sessions.json";
          },
          openSessionManager: () => ({}),
          repairSessionData: async () => false,
          createSession: async () => ({
            session: {
              subscribe: (cb) => {
                listener = cb;
                return () => undefined;
              },
              prompt: async () => {
                listener?.({
                  type: "auto_compaction_end",
                  aborted: false,
                  willRetry: false,
                  result: { summary: "compacted" },
                });
              },
              dispose: () => undefined,
            },
          }),
        });

        await runAgent({
          runId: "run-compaction-event",
          prompt: "hello",
          sessionKey: "main",
          sessionEntriesPath: "/tmp/adjutant-sessions.json",
        });

        assert.equal(persisted.main?.compactionCount, 2);
      }
    );
  });

  it("context_overflow 時は compact() を優先して再試行する", async () => {
    let calls = 0;
    let compactCalls = 0;
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
          compact: async () => {
            compactCalls += 1;
          },
          dispose: () => undefined,
        },
      }),
    });

    await runAgent({
      runId: "run-retry-context-compact",
      prompt: "x".repeat(1200),
      sessionKey: "slack:channel:C1",
    });

    assert.equal(calls, 2);
    assert.equal(compactCalls, 1);
    assert.equal(prompts[1], prompts[0]);
  });

  it("workspace が read-only の場合は memory flush をスキップする", async () => {
    await withEnv(
      {
        ADJUTANT_MEMORY_FLUSH_ENABLED: "true",
        ADJUTANT_COMPACTION_RESERVE_TOKENS_FLOOR: "10000",
        ADJUTANT_MEMORY_FLUSH_SOFT_THRESHOLD_TOKENS: "10000",
      },
      async () => {
        const prompts: string[] = [];

        setAgentRunnerRuntimeForTest({
          ...inMemorySessionStoreRuntime(),
          nowMs: () => 1000,
          acquireLock: async () => () => undefined,
          openSessionManager: () => ({}),
          isWorkspaceWritable: async () => false,
          readMemoryFiles: async () => ({ longTerm: null, daily: null, yesterday: null }),
          createSession: async () => ({
            session: {
              subscribe: () => () => undefined,
              getContextUsage: () => ({ tokens: 80_000, contextWindow: 100_000, percent: 80 }),
              prompt: async (text) => {
                prompts.push(text);
              },
              dispose: () => undefined,
            },
          }),
        });

        await runAgent({
          runId: "run-preflush-readonly",
          prompt: "hello",
          sessionKey: "main",
        });

        assert.deepEqual(prompts, ["hello"]);
      }
    );
  });

  it("context tokens が null の場合は memory flush をスキップする", async () => {
    await withEnv(
      {
        ADJUTANT_MEMORY_FLUSH_ENABLED: "true",
        ADJUTANT_COMPACTION_RESERVE_TOKENS_FLOOR: "10000",
        ADJUTANT_MEMORY_FLUSH_SOFT_THRESHOLD_TOKENS: "10000",
      },
      async () => {
        const prompts: string[] = [];

        setAgentRunnerRuntimeForTest({
          ...inMemorySessionStoreRuntime(),
          nowMs: () => 1000,
          acquireLock: async () => () => undefined,
          openSessionManager: () => ({}),
          readMemoryFiles: async () => ({ longTerm: null, daily: null, yesterday: null }),
          createSession: async () => ({
            session: {
              subscribe: () => () => undefined,
              getContextUsage: () => ({ tokens: null, contextWindow: 100_000, percent: null }),
              prompt: async (text) => {
                prompts.push(text);
              },
              dispose: () => undefined,
            },
          }),
        });

        await runAgent({
          runId: "run-preflush-null-tokens",
          prompt: "hello",
          sessionKey: "main",
        });

        assert.deepEqual(prompts, ["hello"]);
      }
    );
  });

  it("同一 compaction cycle では memory flush を再実行しない", async () => {
    await withEnv(
      {
        ADJUTANT_MEMORY_FLUSH_ENABLED: "true",
        ADJUTANT_COMPACTION_RESERVE_TOKENS_FLOOR: "10000",
        ADJUTANT_MEMORY_FLUSH_SOFT_THRESHOLD_TOKENS: "10000",
      },
      async () => {
        const prompts: string[] = [];
        const persisted: Record<string, Record<string, unknown>> = {
          main: {
            compactionCount: 3,
            memoryFlushCompactionCount: 3,
          },
        };

        setAgentRunnerRuntimeForTest({
          nowMs: () => 1000,
          acquireLock: async () => () => undefined,
          readMemoryFiles: async () => ({ longTerm: null, daily: null, yesterday: null }),
          loadSessionEntryStore: async () => ({
            path: "/tmp/adjutant-sessions.json",
            store: structuredClone(persisted),
          }),
          saveSessionEntryStore: async (store) => {
            for (const key of Object.keys(persisted)) {
              delete persisted[key];
            }
            Object.assign(persisted, structuredClone(store));
            return "/tmp/adjutant-sessions.json";
          },
          openSessionManager: () => ({}),
          repairSessionData: async () => false,
          createSession: async () => ({
            session: {
              subscribe: () => () => undefined,
              getContextUsage: () => ({ tokens: 80_000, contextWindow: 100_000, percent: 80 }),
              prompt: async (text) => {
                prompts.push(text);
              },
              dispose: () => undefined,
            },
          }),
        });

        await runAgent({
          runId: "run-preflush-cycle-guard",
          prompt: "hello",
          sessionKey: "main",
          sessionEntriesPath: "/tmp/adjutant-sessions.json",
        });

        assert.deepEqual(prompts, ["hello"]);
      }
    );
  });

  it("isHeartbeat=true では pre-compaction memory flush を実行しない", async () => {
    await withEnv(
      {
        ADJUTANT_MEMORY_FLUSH_ENABLED: "true",
        ADJUTANT_COMPACTION_RESERVE_TOKENS_FLOOR: "10000",
        ADJUTANT_MEMORY_FLUSH_SOFT_THRESHOLD_TOKENS: "10000",
      },
      async () => {
        const prompts: string[] = [];

        setAgentRunnerRuntimeForTest({
          ...inMemorySessionStoreRuntime(),
          nowMs: () => 1000,
          acquireLock: async () => () => undefined,
          openSessionManager: () => ({}),
          readMemoryFiles: async () => ({ longTerm: null, daily: null, yesterday: null }),
          createSession: async () => ({
            session: {
              subscribe: () => () => undefined,
              getContextUsage: () => ({ tokens: 80_000, contextWindow: 100_000, percent: 80 }),
              prompt: async (text) => {
                prompts.push(text);
              },
              dispose: () => undefined,
            },
          }),
        });

        await runAgent({
          runId: "run-preflush-heartbeat-skip",
          prompt: "heartbeat",
          sessionKey: "main",
          isHeartbeat: true,
        });

        assert.deepEqual(prompts, ["heartbeat"]);
      }
    );
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

  it("デフォルト実装は sessionEntriesPath の親ディレクトリを transcript 保存先に使う", async () => {
    const createMock = mock.method(
      SessionManager as unknown as {
        create: (workspaceDir: string, sessionDir: string) => unknown;
      },
      "create",
      (_workspaceDir: string, _sessionDir: string) => {
        return { isPersisted: () => true };
      }
    );

    try {
      setAgentRunnerRuntimeForTest({
        ...inMemorySessionStoreRuntime(),
        nowMs: () => 1000,
        createSession: async () => ({
          session: {
            sessionId: "session-main-001",
            sessionFile: "session-main-001.jsonl",
            subscribe: () => () => undefined,
            prompt: async () => undefined,
            dispose: () => undefined,
          },
        }),
      });

      await runAgent({
        runId: "run-session-dir",
        prompt: "hello",
        sessionKey: "main",
        workspaceDir: "/tmp/workspace",
        sessionEntriesPath: "/tmp/adjutant-state/agents/main/sessions/sessions.json",
      });

      assert.equal(createMock.mock.calls.length, 1);
      const args = createMock.mock.calls[0]?.arguments ?? [];
      assert.equal(args[0], "/tmp/workspace");
      assert.equal(args[1], "/tmp/adjutant-state/agents/main/sessions");
    } finally {
      createMock.mock.restore();
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

  it("origin=user かつ main では BOOTSTRAP を含む Project Context を注入する", async () => {
    const rootDir = await mkdtemp(`${tmpdir()}/adjutant-bootstrap-`);
    const workspaceDir = join(rootDir, "workspace");
    const sessionEntriesPath = join(rootDir, "sessions.json");
    let capturedPrompt = "";

    try {
      setAgentRunnerRuntimeForTest({
        ...inMemorySessionStoreRuntime(),
        nowMs: () => 1000,
        acquireLock: async () => () => undefined,
        openSessionManager: () => ({}),
        readMemoryFiles: async () => ({ longTerm: null, daily: null, yesterday: null }),
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
        runId: "run-bootstrap-inject-main",
        prompt: "hello",
        sessionKey: "main",
        origin: "user",
        workspaceDir,
        sessionEntriesPath,
      });

      assert.equal(capturedPrompt.includes("# Project Context"), true);
      assert.equal(capturedPrompt.includes("## BOOTSTRAP.md"), true);
      assert.equal(await pathExists(join(workspaceDir, "AGENTS.md")), true);
      assert.equal(await pathExists(join(workspaceDir, "SOUL.md")), true);
      assert.equal(await pathExists(join(workspaceDir, "TOOLS.md")), true);
      assert.equal(await pathExists(join(workspaceDir, "IDENTITY.md")), true);
      assert.equal(await pathExists(join(workspaceDir, "USER.md")), true);
      assert.equal(await pathExists(join(workspaceDir, "HEARTBEAT.md")), true);
      assert.equal(await pathExists(join(workspaceDir, "BOOTSTRAP.md")), true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("origin=pipeline では BOOTSTRAP context を注入しない", async () => {
    const rootDir = await mkdtemp(`${tmpdir()}/adjutant-bootstrap-`);
    const workspaceDir = join(rootDir, "workspace");
    const sessionEntriesPath = join(rootDir, "sessions.json");
    let capturedPrompt = "";

    try {
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(join(workspaceDir, "BOOTSTRAP.md"), "bootstrap-content", "utf8");

      setAgentRunnerRuntimeForTest({
        ...inMemorySessionStoreRuntime(),
        nowMs: () => 1000,
        acquireLock: async () => () => undefined,
        openSessionManager: () => ({}),
        readMemoryFiles: async () => ({ longTerm: null, daily: null, yesterday: null }),
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
        runId: "run-bootstrap-skip-pipeline",
        prompt: "hello",
        sessionKey: "main",
        origin: "pipeline",
        workspaceDir,
        sessionEntriesPath,
      });

      assert.equal(capturedPrompt.includes("# Project Context"), false);
      assert.equal(capturedPrompt.includes("BOOTSTRAP.md"), false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("isHeartbeat=true では BOOTSTRAP context を注入しない", async () => {
    const rootDir = await mkdtemp(`${tmpdir()}/adjutant-bootstrap-`);
    const workspaceDir = join(rootDir, "workspace");
    const sessionEntriesPath = join(rootDir, "sessions.json");
    let capturedPrompt = "";

    try {
      setAgentRunnerRuntimeForTest({
        ...inMemorySessionStoreRuntime(),
        nowMs: () => 1000,
        acquireLock: async () => () => undefined,
        openSessionManager: () => ({}),
        readMemoryFiles: async () => ({ longTerm: null, daily: null, yesterday: null }),
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
        runId: "run-bootstrap-skip-heartbeat",
        prompt: "hello",
        sessionKey: "main",
        origin: "user",
        isHeartbeat: true,
        workspaceDir,
        sessionEntriesPath,
      });

      assert.equal(capturedPrompt.includes("# Project Context"), false);
      assert.equal(capturedPrompt.includes("BOOTSTRAP.md"), false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("BOOTSTRAP.md 削除後は次ターンで注入されない", async () => {
    const rootDir = await mkdtemp(`${tmpdir()}/adjutant-bootstrap-`);
    const workspaceDir = join(rootDir, "workspace");
    const sessionEntriesPath = join(rootDir, "sessions.json");
    const prompts: string[] = [];

    try {
      setAgentRunnerRuntimeForTest({
        ...inMemorySessionStoreRuntime(),
        nowMs: (() => {
          let tick = 1000;
          return () => {
            tick += 1;
            return tick;
          };
        })(),
        acquireLock: async () => () => undefined,
        openSessionManager: () => ({}),
        readMemoryFiles: async () => ({ longTerm: null, daily: null, yesterday: null }),
        createSession: async () => ({
          session: {
            subscribe: () => () => undefined,
            prompt: async (prompt) => {
              prompts.push(prompt);
            },
            dispose: () => undefined,
          },
        }),
      });

      await runAgent({
        runId: "run-bootstrap-delete-1",
        prompt: "hello",
        sessionKey: "main",
        origin: "user",
        workspaceDir,
        sessionEntriesPath,
      });

      await rm(join(workspaceDir, "BOOTSTRAP.md"), { force: true });

      await runAgent({
        runId: "run-bootstrap-delete-2",
        prompt: "hello again",
        sessionKey: "main",
        origin: "user",
        workspaceDir,
        sessionEntriesPath,
      });

      assert.equal(prompts.length >= 2, true);
      assert.equal(prompts[0]?.includes("## BOOTSTRAP.md"), true);
      assert.equal(prompts[1]?.includes("## BOOTSTRAP.md"), false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
