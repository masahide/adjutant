import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { loadCollectorSlackConfig } from "../src/collector-slack/config.js";
import {
  connectToSlackPage,
  type SlackCdpClient,
} from "../legacy/impl-20260228/src/runtime/slackConnection.js";
import { SlackAdapter } from "../legacy/impl-20260228/src/slack/adapter.js";

type DebugEventRecord = {
  schema: "adjutant.slack-debug.event.v1";
  logged_at: string;
  source: string;
  kind: string;
  at: string;
  payload: unknown;
};

class DebugEventFileLogger {
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly maxPayloadChars: number;
  private readonly ensureDirPromise: Promise<unknown>;

  constructor(
    private readonly filePath: string,
    maxPayloadChars: number
  ) {
    this.maxPayloadChars = Math.max(0, maxPayloadChars);
    this.ensureDirPromise = mkdir(dirname(this.filePath), { recursive: true });
  }

  record(event: { source: string; kind: string; at: string; payload: unknown }): void {
    const line = `${JSON.stringify(this.normalizeRecord(event))}\n`;
    this.writeQueue = this.writeQueue.then(async () => {
      await this.ensureDirPromise;
      await appendFile(this.filePath, line, "utf8");
    });
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private normalizeRecord(event: {
    source: string;
    kind: string;
    at: string;
    payload: unknown;
  }): DebugEventRecord {
    return {
      schema: "adjutant.slack-debug.event.v1",
      logged_at: new Date().toISOString(),
      source: event.source,
      kind: event.kind,
      at: event.at,
      payload: this.normalizePayload(event.payload),
    };
  }

  private normalizePayload(payload: unknown): unknown {
    if (this.maxPayloadChars <= 0) {
      return payload;
    }
    try {
      const serialized = JSON.stringify(payload);
      if (serialized.length <= this.maxPayloadChars) {
        return payload;
      }
      return {
        _truncated: true,
        original_length: serialized.length,
        preview: serialized.slice(0, this.maxPayloadChars),
      };
    } catch {
      return { _truncated: true, reason: "failed_to_stringify" };
    }
  }
}

function resolveLogPath(): string {
  const config = loadCollectorSlackConfig();
  const fromEnv =
    process.env.ADJUTANT_RAW_LOG_PATH?.trim() || process.env.ADJUTANT_RAW_FETCH_LOG_PATH?.trim();
  return resolve(fromEnv || join(config.dataDir, "_debug", "slack-debug.jsonl"));
}

function resolveMaxPayloadChars(): number {
  const raw = process.env.ADJUTANT_RAW_FETCH_LOG_MAX_PAYLOAD_CHARS?.trim() || "20000";
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 20_000;
}

function waitForDisconnect(client: SlackCdpClient): Promise<void> {
  return new Promise((resolve, reject) => {
    const onDisconnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      client.removeListener("disconnect", onDisconnect);
      client.removeListener("error", onError);
      if (typeof client.off === "function") {
        client.off("disconnect", onDisconnect);
        client.off("error", onError);
      }
    };
    client.on("disconnect", onDisconnect);
    client.on("error", onError);
  });
}

async function main(): Promise<void> {
  const config = loadCollectorSlackConfig();
  const logPath = resolveLogPath();
  const logger = new DebugEventFileLogger(logPath, resolveMaxPayloadChars());
  const { host, port } = config.endpoint;
  const timezone = process.env.ADJUTANT_TZ?.trim() || "Asia/Tokyo";
  const channelCachePath = join(config.dataDir, "_cache", "slack", "channel-names-by-team.json");
  const userCachePath = join(config.dataDir, "_cache", "slack", "user-names-by-team.json");

  console.log(`[rawlog] CDP endpoint -> ${host}:${port}`);
  console.log(`[rawlog] output -> ${logPath}`);

  const { client, slackUrl } = await connectToSlackPage(host, port);
  console.log(`[rawlog] attached to -> ${slackUrl}`);
  logger.record({
    source: "rawlog-capture",
    kind: "session_start",
    at: new Date().toISOString(),
    payload: {
      slack_url: slackUrl,
      workspace_host: (() => {
        try {
          return new URL(slackUrl).host;
        } catch {
          return undefined;
        }
      })(),
    },
  });

  const adapter = new SlackAdapter({
    client,
    now: () => new Date(),
    timezone,
    domCaptureDisabled: false,
    channelCachePath,
    userCachePath,
    debugFetchHookEnabled: true,
    onDebugEvent: (event) => {
      logger.record(event);
    },
  });

  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[rawlog] shutting down (${reason})`);
    try {
      await adapter.stop();
    } finally {
      try {
        await client.close();
      } finally {
        await logger.flush();
      }
    }
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT").finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM").finally(() => process.exit(0));
  });

  await adapter.start(async () => {});
  console.log("[rawlog] capture started");
  console.log("[rawlog] Slack で自分宛メンション通知を発生させてください");
  console.log("[rawlog] 終了は Ctrl+C");

  try {
    await waitForDisconnect(client);
  } finally {
    await shutdown("disconnect");
  }
}

void main().catch((error) => {
  console.error("[rawlog] fatal:", error);
  process.exit(1);
});
