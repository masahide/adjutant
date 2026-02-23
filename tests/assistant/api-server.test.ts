import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../../src/assistant/api-server.js";
import * as ChatHandler from "../../src/assistant/chat-handler.js";
import * as StreamEventBridge from "../../src/assistant/stream-event-bridge.js";
import type { StreamEvent } from "../../src/assistant/types.js";
import {
  configureChatHandlerForTest,
  resetChatHandlerTestState,
} from "./chat-handler-test-helpers.js";

function makeStubAgent(): ChatHandler.AgentRunFn {
  return async ({ runId, sessionKey, onDelta }) => {
    onDelta({
      runId,
      sessionKey,
      seq: 0,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "stub " }] },
    } satisfies StreamEvent);
    onDelta({
      runId,
      sessionKey,
      seq: 0,
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "reply" }] },
    } satisfies StreamEvent);
    return { status: "completed" };
  };
}

let stop: () => Promise<void>;
let port: number;

async function setupServer(
  agentFn?: ChatHandler.AgentRunFn,
  overrides?: {
    sessionEntriesPath?: string;
    agentAuditLogPath?: string;
    heartbeatRunsPath?: string;
  }
) {
  resetChatHandlerTestState();
  configureChatHandlerForTest(agentFn ?? makeStubAgent());

  port = 3100 + Math.floor(Math.random() * 900);
  const api = createApiServer({ port, host: "127.0.0.1", ...overrides });
  await api.start();
  stop = api.stop;
}

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

describe("ApiServer", () => {
  afterEach(async () => {
    if (stop) await stop();
  });

  it("POST /api/chat/messages は 200 + runId を返す", async () => {
    await setupServer();
    const res = await fetch(url("/api/chat/messages"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "hello",
        sessionKey: "main",
        idempotencyKey: "test-001",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { runId: string; status: string };
    assert.equal(body.runId, "test-001");
    assert.equal(body.status, "started");
  });

  it("POST /api/chat/messages は追加フィールドがあっても最小契約で継続動作する", async () => {
    await setupServer();
    const res = await fetch(url("/api/chat/messages"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "hello",
        sessionKey: "main",
        idempotencyKey: "minimal-contract-001",
        accountId: "acc-1",
        eventUids: ["u-1", "u-2"],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { runId: string; status: string };
    assert.equal(body.runId, "minimal-contract-001");
    assert.equal(body.status, "started");
  });

  it("POST /api/chat/messages は origin を受理して runAgent へ渡す", async () => {
    let capturedOrigin: string | undefined;
    await setupServer(async ({ runId, sessionKey, origin, onDelta }) => {
      capturedOrigin = origin;
      onDelta({
        runId,
        sessionKey,
        seq: 0,
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "reply" }] },
      } satisfies StreamEvent);
      return { status: "completed" };
    });

    const res = await fetch(url("/api/chat/messages"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "hello",
        sessionKey: "main",
        idempotencyKey: "origin-propagation-001",
        origin: "pipeline",
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(capturedOrigin, "pipeline");
  });

  it("POST /api/chat/messages は sessionKey 欠落で 400", async () => {
    await setupServer();
    const res = await fetch(url("/api/chat/messages"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello", idempotencyKey: "k1" }),
    });
    assert.equal(res.status, 400);
  });

  it("POST /api/chat/messages は非オブジェクト body で 400", async () => {
    await setupServer();
    const res = await fetch(url("/api/chat/messages"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([1, 2, 3]),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("JSON object"));
  });

  it("POST /api/chat/abort は sessionKey 欠落で 400", async () => {
    await setupServer();
    const res = await fetch(url("/api/chat/abort"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it("POST /api/chat/abort は ok を返す", async () => {
    await setupServer();
    const res = await fetch(url("/api/chat/abort"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey: "main" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  });

  it("GET /api/chat/runs/:runId/stream は SSE を返す", async () => {
    await setupServer();

    // まずメッセージを送信
    await fetch(url("/api/chat/messages"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "hello",
        sessionKey: "main",
        idempotencyKey: "stream-001",
      }),
    });

    // 少し待ってからstreamに接続
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(url("/api/chat/runs/stream-001/stream"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");

    const text = await res.text();
    assert.ok(text.includes("event: chat"), "SSE should contain event: chat");
    assert.ok(text.includes("id: stream-001:1"), "SSE should contain id field");
  });

  it("GET /api/chat/runs/:runId/stream は Last-Event-ID 以降のみ再送する", async () => {
    await setupServer();

    await fetch(url("/api/chat/messages"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "hello",
        sessionKey: "main",
        idempotencyKey: "replay-001",
      }),
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(url("/api/chat/runs/replay-001/stream"), {
      headers: { "Last-Event-ID": "replay-001:1" },
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    const lines = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as StreamEvent);
    assert.deepEqual(
      lines.map((line) => line.seq),
      [2]
    );
  });

  it("GET /api/chat/runs/:runId/stream は古すぎる Last-Event-ID で 409", async () => {
    await setupServer();
    StreamEventBridge.configureReplay({ maxEventsPerRun: 1 });

    await fetch(url("/api/chat/messages"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "hello",
        sessionKey: "main",
        idempotencyKey: "expired-001",
      }),
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(url("/api/chat/runs/expired-001/stream"), {
      headers: { "Last-Event-ID": "expired-001:0" },
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, "LAST_EVENT_ID_EXPIRED");
  });

  it("GET /api/chat/history は sessionKey 必須", async () => {
    await setupServer();
    const res = await fetch(url("/api/chat/history"));
    assert.equal(res.status, 400);
  });

  it("GET /api/chat/history は sessionKey 指定で 200 + sessionId を含む", async () => {
    await setupServer();
    const res = await fetch(url("/api/chat/history?sessionKey=main"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      sessionKey: string;
      sessionId: string;
      messages: unknown[];
    };
    assert.equal(body.sessionKey, "main");
    assert.equal(body.sessionId, "main");
    assert.ok(Array.isArray(body.messages));
  });

  it("GET /api/chat/history は heartbeat/system を除外し runId/toolCount を返す", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-api-server-`);
    try {
      const sessionsPath = join(dir, "sessions.json");
      const transcriptPath = join(dir, "main.jsonl");
      const auditPath = join(dir, "agent-audit.ndjson");
      await writeFile(
        sessionsPath,
        JSON.stringify({
          main: { sessionId: "main", sessionFile: transcriptPath },
        }),
        "utf8"
      );
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({
            message: {
              role: "user",
              runId: "run-user-1",
              content: [{ type: "text", text: "通常メッセージ" }],
            },
          }),
          JSON.stringify({
            message: {
              role: "assistant",
              runId: "run-user-1",
              content: [{ type: "text", text: "通常応答" }],
            },
          }),
          JSON.stringify({
            message: {
              role: "user",
              runId: "run-hb",
              content: [{ type: "text", text: "# HEARTBEAT\nping" }],
            },
          }),
          JSON.stringify({
            message: {
              role: "assistant",
              runId: "run-hb",
              content: [{ type: "text", text: "heartbeat response" }],
            },
          }),
          JSON.stringify({
            message: {
              role: "system",
              runId: "run-sys",
              content: [{ type: "text", text: "compaction" }],
            },
          }),
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        auditPath,
        [
          JSON.stringify({ type: "run.start", runId: "run-hb", origin: "system" }),
          JSON.stringify({ type: "tool.end", runId: "run-user-1", toolName: "bash", status: "ok" }),
          JSON.stringify({
            type: "tool.end",
            runId: "run-user-1",
            toolName: "read_file",
            status: "ok",
          }),
        ].join("\n"),
        "utf8"
      );

      await setupServer(undefined, {
        sessionEntriesPath: sessionsPath,
        agentAuditLogPath: auditPath,
      });
      const res = await fetch(url("/api/chat/history?sessionKey=main"));
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        messages: Array<{ role: string; runId?: string; toolCount?: number }>;
      };
      assert.equal(body.messages.length, 2);
      assert.deepEqual(
        body.messages.map((item) => item.role),
        ["user", "assistant"]
      );
      assert.equal(body.messages[1]?.runId, "run-user-1");
      assert.equal(body.messages[1]?.toolCount, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("GET /api/chat/runs/:runId/audit は tool.start/end をペアリングして返す", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-api-server-`);
    try {
      const auditPath = join(dir, "agent-audit.ndjson");
      await writeFile(
        auditPath,
        [
          JSON.stringify({ type: "run.start", runId: "run-abc", origin: "user" }),
          JSON.stringify({
            type: "tool.start",
            runId: "run-abc",
            toolName: "bash",
            toolCallId: "tc-1",
            args: { command: "ls -la" },
            ts: "2026-02-23T10:00:00.000Z",
          }),
          JSON.stringify({
            type: "tool.end",
            runId: "run-abc",
            toolName: "bash",
            toolCallId: "tc-1",
            status: "ok",
            durationMs: 44,
            ts: "2026-02-23T10:00:00.044Z",
          }),
          JSON.stringify({
            type: "run.end",
            runId: "run-abc",
            status: "ok",
          }),
        ].join("\n"),
        "utf8"
      );

      await setupServer(undefined, { agentAuditLogPath: auditPath });
      const res = await fetch(url("/api/chat/runs/run-abc/audit"));
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        runId: string;
        origin?: string;
        runEnded?: boolean;
        tools: Array<{
          toolName: string;
          toolCallId?: string;
          status?: string;
          durationMs?: number;
        }>;
      };
      assert.equal(body.runId, "run-abc");
      assert.equal(body.origin, "user");
      assert.equal(body.runEnded, true);
      assert.equal(body.tools.length, 1);
      assert.equal(body.tools[0]?.toolName, "bash");
      assert.equal(body.tools[0]?.toolCallId, "tc-1");
      assert.equal(body.tools[0]?.status, "ok");
      assert.equal(body.tools[0]?.durationMs, 44);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("GET /api/heartbeat/history は cursor で重複なくページングできる", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-api-server-`);
    try {
      const heartbeatRunsPath = join(dir, "heartbeat-runs.jsonl");
      const lines = Array.from({ length: 25 }, (_, index) =>
        JSON.stringify({
          schema: "adjutant.heartbeat.result.v1",
          runAt: new Date(
            Date.parse("2026-02-23T10:30:00.000Z") - Math.floor(index / 5) * 60_000
          ).toISOString(),
          sessionKey: "main",
          result: { status: "ran", durationMs: index + 1 },
          preview: `preview-${index}`,
        })
      );
      await writeFile(heartbeatRunsPath, lines.join("\n"), "utf8");

      await setupServer(undefined, { heartbeatRunsPath });
      const firstRes = await fetch(url("/api/heartbeat/history?limit=10"));
      assert.equal(firstRes.status, 200);
      const firstBody = (await firstRes.json()) as {
        records: Array<{ preview?: string }>;
        hasMore: boolean;
        nextCursor: string | null;
      };
      assert.equal(firstBody.records.length, 10);
      assert.equal(firstBody.hasMore, true);
      assert.equal(typeof firstBody.nextCursor, "string");

      const secondRes = await fetch(
        url(`/api/heartbeat/history?limit=10&cursor=${encodeURIComponent(firstBody.nextCursor!)}`)
      );
      assert.equal(secondRes.status, 200);
      const secondBody = (await secondRes.json()) as {
        records: Array<{ preview?: string }>;
        hasMore: boolean;
        nextCursor: string | null;
      };
      assert.equal(secondBody.records.length, 10);

      const thirdRes = await fetch(
        url(`/api/heartbeat/history?limit=10&cursor=${encodeURIComponent(secondBody.nextCursor!)}`)
      );
      assert.equal(thirdRes.status, 200);
      const thirdBody = (await thirdRes.json()) as {
        records: Array<{ preview?: string }>;
        hasMore: boolean;
        nextCursor: string | null;
      };
      assert.equal(thirdBody.records.length, 5);
      assert.equal(thirdBody.hasMore, false);
      assert.equal(thirdBody.nextCursor, null);

      const seen = new Set<string>();
      for (const record of [...firstBody.records, ...secondBody.records, ...thirdBody.records]) {
        if (record.preview) {
          assert.equal(seen.has(record.preview), false);
          seen.add(record.preview);
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("GET /api/heartbeat/history は不正 cursor で 400", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-api-server-`);
    try {
      const heartbeatRunsPath = join(dir, "heartbeat-runs.jsonl");
      await writeFile(
        heartbeatRunsPath,
        JSON.stringify({
          schema: "adjutant.heartbeat.result.v1",
          runAt: "2026-02-23T10:30:00.000Z",
          sessionKey: "main",
          result: { status: "ran", durationMs: 1 },
        }),
        "utf8"
      );

      await setupServer(undefined, { heartbeatRunsPath });
      const res = await fetch(url("/api/heartbeat/history?limit=10&cursor=invalid-cursor"));
      assert.equal(res.status, 400);
      const body = (await res.json()) as { code?: string };
      assert.equal(body.code, "INVALID_REQUEST");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("GET /api/heartbeat/last はプロバイダ未設定で null を返す", async () => {
    await setupServer();
    const res = await fetch(url("/api/heartbeat/last"));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body, "null");
  });

  it("GET /api/heartbeat/last はプロバイダ設定時にスナップショットを返す", async () => {
    resetChatHandlerTestState();
    configureChatHandlerForTest(makeStubAgent());

    port = 3100 + Math.floor(Math.random() * 900);
    const api = createApiServer({
      port,
      host: "127.0.0.1",
      heartbeatProvider: {
        onHeartbeatEvent: () => () => {},
        getLastHeartbeatEvent: () => ({
          ts: 1000,
          status: "sent",
          preview: "test",
          indicatorType: "ok",
        }),
        runOnce: async () => ({ status: "ran", durationMs: 100 }),
      },
    });
    await api.start();
    stop = api.stop;

    const res = await fetch(url("/api/heartbeat/last"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ts: number; status: string };
    assert.equal(body.ts, 1000);
    assert.equal(body.status, "sent");
  });

  it("POST /api/heartbeat/run は未設定で 501", async () => {
    await setupServer();
    const res = await fetch(url("/api/heartbeat/run"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 501);
  });

  it("未知のエンドポイントは 404", async () => {
    await setupServer();
    const res = await fetch(url("/api/unknown"));
    assert.equal(res.status, 404);
  });

  it("冪等: 同一キー再送は同じ runId を返す", async () => {
    await setupServer();
    const body1 = JSON.stringify({
      message: "hello",
      sessionKey: "main",
      idempotencyKey: "dup-001",
    });
    const res1 = await fetch(url("/api/chat/messages"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body1,
    });
    const json1 = (await res1.json()) as { runId: string };

    const res2 = await fetch(url("/api/chat/messages"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body1,
    });
    const json2 = (await res2.json()) as { runId: string; status: string };

    assert.equal(json1.runId, json2.runId);
    assert.ok(
      json2.status === "in_flight" || json2.status === "ok",
      `expected in_flight or ok, got ${json2.status}`
    );
  });

  it("POST /api/chat/messages は Idempotency-Key ヘッダを優先する", async () => {
    await setupServer();
    const res = await fetch(url("/api/chat/messages"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "header-priority-001",
      },
      body: JSON.stringify({
        message: "hello",
        sessionKey: "main",
        idempotencyKey: "body-ignored-001",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { runId: string };
    assert.equal(body.runId, "header-priority-001");
  });

  it("POST /api/chat/messages は clientMessageId を互換受理する", async () => {
    await setupServer();
    const res = await fetch(url("/api/chat/messages"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "hello",
        sessionKey: "main",
        clientMessageId: "legacy-client-msg-001",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { runId: string };
    assert.equal(body.runId, "legacy-client-msg-001");
  });

  it("POST /api/chat/messages は同一キーで payload が異なると 409", async () => {
    await setupServer();
    await fetch(url("/api/chat/messages"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "hello",
        sessionKey: "main",
        idempotencyKey: "mismatch-001",
      }),
    });

    const res = await fetch(url("/api/chat/messages"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "hello changed",
        sessionKey: "main",
        idempotencyKey: "mismatch-001",
      }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
  });

  it("seq は runId ごとに単調増加する", async () => {
    await setupServer();

    await fetch(url("/api/chat/messages"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "hello",
        sessionKey: "main",
        idempotencyKey: "seq-001",
      }),
    });

    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(url("/api/chat/runs/seq-001/stream"));
    const text = await res.text();
    const lines = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5)) as StreamEvent);

    for (let i = 1; i < lines.length; i++) {
      assert.ok(lines[i].seq > lines[i - 1].seq, `seq should be monotonically increasing`);
    }
  });
});
