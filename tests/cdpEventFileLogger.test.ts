import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CdpEventFileLogger } from "../src/io/cdpEventFileLogger.js";
import type { SlackCdpClient } from "../src/runtime/slackConnection.js";

describe("CdpEventFileLogger", () => {
  it("CDP eventをjsonlへ追記しdetach後は記録しない", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "adjutant-cdp-log-"));
    const logPath = join(tempDir, "cdp-events.jsonl");
    const logger = new CdpEventFileLogger({ filePath: logPath });
    const client = new EventEmitter() as SlackCdpClient;

    const detach = logger.attach(client, {
      host: "127.0.0.1",
      port: 9222,
      slackUrl: "https://app.slack.com/client/T1/C1",
    });

    client.emit("event", {
      method: "Network.responseReceived",
      sessionId: "session-1",
      params: {
        requestId: "req-1",
        response: { url: "https://example.slack.com/api/conversations.view", status: 200 },
      },
    });
    await logger.flush();

    let content = await readFile(logPath, "utf8");
    let lines = content.trim().split("\n");
    assert.equal(lines.length, 1);
    const first = JSON.parse(lines[0]) as {
      schema?: string;
      method?: string;
      session_id?: string;
      host?: string;
      port?: number;
      slack_url?: string;
      params?: { requestId?: string };
    };
    assert.equal(first.schema, "adjutant.cdp.event.v1");
    assert.equal(first.method, "Network.responseReceived");
    assert.equal(first.session_id, "session-1");
    assert.equal(first.host, "127.0.0.1");
    assert.equal(first.port, 9222);
    assert.equal(first.slack_url, "https://app.slack.com/client/T1/C1");
    assert.equal(first.params?.requestId, "req-1");

    detach();
    client.emit("event", {
      method: "Network.loadingFinished",
      params: { requestId: "req-1" },
    });
    await logger.flush();

    content = await readFile(logPath, "utf8");
    lines = content.trim().split("\n");
    assert.equal(lines.length, 1, "detach後は追記されないこと");

    await rm(tempDir, { recursive: true, force: true });
  });
});
