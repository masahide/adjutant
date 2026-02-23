import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  readAuditRunMetadata,
  readRunAudit,
  resetAuditReaderCacheForTest,
  setAuditReaderNowMsForTest,
} from "../../src/assistant/audit-reader.js";

describe("audit-reader", () => {
  afterEach(() => {
    resetAuditReaderCacheForTest();
    setAuditReaderNowMsForTest(null);
  });

  it("runId を指定して tool.start/end をペアリングできる", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-audit-reader-`);
    try {
      const path = join(dir, "agent-audit.ndjson");
      await writeFile(
        path,
        [
          JSON.stringify({
            type: "run.start",
            runId: "run-abc",
            origin: "user",
          }),
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
            resultSummary: "ok",
            status: "ok",
            durationMs: 120,
            ts: "2026-02-23T10:00:00.120Z",
          }),
          JSON.stringify({
            type: "tool.start",
            runId: "run-abc",
            toolName: "read_file",
            args: { path: "README.md" },
            ts: "2026-02-23T10:00:01.000Z",
          }),
          JSON.stringify({
            type: "tool.end",
            runId: "run-abc",
            toolName: "read_file",
            status: "error",
            error: "ENOENT",
            ts: "2026-02-23T10:00:01.200Z",
          }),
          JSON.stringify({
            type: "tool.start",
            runId: "run-abc",
            toolName: "write_file",
            toolCallId: "tc-2",
            ts: "2026-02-23T10:00:02.000Z",
          }),
          "{broken-json",
        ].join("\n"),
        "utf8"
      );

      const response = await readRunAudit("run-abc", { auditLogPath: path });
      assert.equal(response.runId, "run-abc");
      assert.equal(response.origin, "user");
      assert.equal(response.runEnded, false);
      assert.equal(response.tools.length, 3);

      const first = response.tools[0]!;
      assert.equal(first.toolName, "bash");
      assert.equal(first.toolCallId, "tc-1");
      assert.equal(first.status, "ok");
      assert.equal(first.durationMs, 120);
      assert.equal(first.startedAt, "2026-02-23T10:00:00.000Z");
      assert.equal(first.endedAt, "2026-02-23T10:00:00.120Z");
      assert.deepEqual(first.args, { command: "ls -la" });

      const second = response.tools[1]!;
      assert.equal(second.toolName, "read_file");
      assert.equal(second.status, "error");
      assert.equal(second.error, "ENOENT");
      assert.equal(second.startedAt, "2026-02-23T10:00:01.000Z");
      assert.equal(second.endedAt, "2026-02-23T10:00:01.200Z");

      const third = response.tools[2]!;
      assert.equal(third.toolName, "write_file");
      assert.equal(third.status, undefined);
      assert.equal(third.startedAt, "2026-02-23T10:00:02.000Z");
      assert.equal(third.endedAt, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("toolCallId なしでも toolName ベースで start/end を対応づける", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-audit-reader-`);
    try {
      const path = join(dir, "agent-audit.ndjson");
      await writeFile(
        path,
        [
          JSON.stringify({ type: "run.start", runId: "run-name-match", origin: "user" }),
          JSON.stringify({
            type: "tool.start",
            runId: "run-name-match",
            toolName: "read_file",
            args: { path: "a.md" },
            ts: "2026-02-23T10:10:00.000Z",
          }),
          JSON.stringify({
            type: "tool.start",
            runId: "run-name-match",
            toolName: "read_file",
            args: { path: "b.md" },
            ts: "2026-02-23T10:10:00.100Z",
          }),
          JSON.stringify({
            type: "tool.end",
            runId: "run-name-match",
            toolName: "read_file",
            status: "ok",
            ts: "2026-02-23T10:10:00.200Z",
          }),
          JSON.stringify({
            type: "tool.end",
            runId: "run-name-match",
            toolName: "read_file",
            status: "ok",
            ts: "2026-02-23T10:10:00.300Z",
          }),
        ].join("\n"),
        "utf8"
      );

      const response = await readRunAudit("run-name-match", { auditLogPath: path });
      assert.equal(response.runEnded, false);
      assert.equal(response.tools.length, 2);
      assert.deepEqual(
        response.tools.map((tool) => tool.args),
        [{ path: "a.md" }, { path: "b.md" }]
      );
      assert.deepEqual(
        response.tools.map((tool) => tool.endedAt),
        ["2026-02-23T10:10:00.300Z", "2026-02-23T10:10:00.200Z"]
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("run.start(origin=system) と tool.end 件数を集計できる", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-audit-reader-`);
    try {
      const path = join(dir, "agent-audit.ndjson");
      await writeFile(
        path,
        [
          JSON.stringify({ type: "run.start", runId: "run-hb-1", origin: "system" }),
          JSON.stringify({
            type: "message.bind",
            runId: "run-user-1",
            messageId: "msg-assistant-1",
            role: "assistant",
          }),
          JSON.stringify({ type: "tool.end", runId: "run-user-1", toolName: "bash", status: "ok" }),
          JSON.stringify({
            type: "tool.end",
            runId: "run-user-1",
            toolName: "read_file",
            status: "ok",
          }),
          JSON.stringify({ type: "run.start", runId: "run-user-2", origin: "user" }),
        ].join("\n"),
        "utf8"
      );

      const metadata = await readAuditRunMetadata({ auditLogPath: path });
      assert.equal(metadata.heartbeatRunIds.has("run-hb-1"), true);
      assert.equal(metadata.heartbeatRunIds.has("run-user-2"), false);
      assert.equal(metadata.toolEndCountByRunId.get("run-user-1"), 2);
      assert.equal(metadata.messageRunIdByMessageId.get("msg-assistant-1"), "run-user-1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runId キャッシュは TTL まで同じ結果を返し、期限後に更新される", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-audit-reader-`);
    try {
      const path = join(dir, "agent-audit.ndjson");
      setAuditReaderNowMsForTest(() => 1000);
      await writeFile(
        path,
        [
          JSON.stringify({ type: "run.start", runId: "run-cache", origin: "user" }),
          JSON.stringify({
            type: "tool.start",
            runId: "run-cache",
            toolName: "bash",
            toolCallId: "tc-1",
          }),
          JSON.stringify({
            type: "tool.end",
            runId: "run-cache",
            toolName: "bash",
            toolCallId: "tc-1",
            status: "ok",
          }),
          JSON.stringify({
            type: "run.end",
            runId: "run-cache",
            status: "ok",
          }),
        ].join("\n"),
        "utf8"
      );

      const first = await readRunAudit("run-cache", { auditLogPath: path });
      assert.equal(first.runEnded, true);
      assert.equal(first.tools.length, 1);

      await writeFile(path, JSON.stringify({ type: "run.start", runId: "run-cache" }), "utf8");
      const cached = await readRunAudit("run-cache", { auditLogPath: path });
      assert.equal(cached.tools.length, 1);

      setAuditReaderNowMsForTest(() => 1000 + 61_000);
      const refreshed = await readRunAudit("run-cache", { auditLogPath: path });
      assert.equal(refreshed.runEnded, false);
      assert.equal(refreshed.tools.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("run.end 前の読み取り結果はキャッシュしない", async () => {
    const dir = await mkdtemp(`${tmpdir()}/adjutant-audit-reader-`);
    try {
      const path = join(dir, "agent-audit.ndjson");
      setAuditReaderNowMsForTest(() => 2000);

      await writeFile(
        path,
        [
          JSON.stringify({ type: "run.start", runId: "run-inflight", origin: "user" }),
          JSON.stringify({
            type: "tool.start",
            runId: "run-inflight",
            toolName: "bash",
            toolCallId: "tc-1",
            ts: "2026-02-23T10:20:00.000Z",
          }),
        ].join("\n"),
        "utf8"
      );
      const first = await readRunAudit("run-inflight", { auditLogPath: path });
      assert.equal(first.runEnded, false);
      assert.equal(first.tools[0]?.endedAt, undefined);

      await writeFile(
        path,
        [
          JSON.stringify({ type: "run.start", runId: "run-inflight", origin: "user" }),
          JSON.stringify({
            type: "tool.start",
            runId: "run-inflight",
            toolName: "bash",
            toolCallId: "tc-1",
            ts: "2026-02-23T10:20:00.000Z",
          }),
          JSON.stringify({
            type: "tool.end",
            runId: "run-inflight",
            toolName: "bash",
            toolCallId: "tc-1",
            status: "ok",
            ts: "2026-02-23T10:20:00.250Z",
          }),
          JSON.stringify({
            type: "run.end",
            runId: "run-inflight",
            status: "ok",
          }),
        ].join("\n"),
        "utf8"
      );

      const second = await readRunAudit("run-inflight", { auditLogPath: path });
      assert.equal(second.runEnded, true);
      assert.equal(second.tools[0]?.endedAt, "2026-02-23T10:20:00.250Z");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
