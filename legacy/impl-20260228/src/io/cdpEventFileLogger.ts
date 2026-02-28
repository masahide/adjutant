import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type CDP from "chrome-remote-interface";
import type { SlackCdpClient } from "../runtime/slackConnection.js";

type CdpSessionInfo = {
  host: string;
  port: number;
  slackUrl: string;
};

type CdpEventFileLoggerOptions = {
  filePath: string;
  now?: () => Date;
  maxParamChars?: number;
};

type CdpEventLogRecord = {
  schema: "adjutant.cdp.event.v1";
  logged_at: string;
  host: string;
  port: number;
  slack_url: string;
  method: string;
  session_id?: string;
  params: unknown;
};

export class CdpEventFileLogger {
  private readonly filePath: string;
  private readonly now: () => Date;
  private readonly maxParamChars: number;
  private readonly ensureDirPromise: Promise<string | undefined>;
  private writeQueue: Promise<void> = Promise.resolve();
  private writeErrorCount = 0;

  constructor(options: CdpEventFileLoggerOptions) {
    this.filePath = options.filePath;
    this.now = options.now ?? (() => new Date());
    this.maxParamChars = Math.max(0, options.maxParamChars ?? 0);
    this.ensureDirPromise = mkdir(dirname(this.filePath), { recursive: true });
  }

  attach(client: SlackCdpClient, session: CdpSessionInfo): () => void {
    const onEvent = (message: CDP.EventMessage) => {
      this.append(message, session);
    };
    client.on("event", onEvent);
    return () => {
      client.removeListener("event", onEvent);
    };
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private append(message: CDP.EventMessage, session: CdpSessionInfo): void {
    const record: CdpEventLogRecord = {
      schema: "adjutant.cdp.event.v1",
      logged_at: this.now().toISOString(),
      host: session.host,
      port: session.port,
      slack_url: session.slackUrl,
      method: message.method,
      session_id: message.sessionId,
      params: this.normalizeParams(message.params),
    };

    const line = this.stringifyRecord(record);
    if (!line) return;

    this.writeQueue = this.writeQueue
      .then(async () => {
        await this.ensureDirPromise;
        await appendFile(this.filePath, line, "utf8");
      })
      .catch((err) => {
        this.writeErrorCount += 1;
        if (this.writeErrorCount <= 3) {
          console.error("[Adjutant] failed to append CDP event log:", err);
        }
      });
  }

  private normalizeParams(params: unknown): unknown {
    if (this.maxParamChars <= 0) {
      return params;
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(params);
    } catch {
      return { _truncated: true, reason: "failed_to_stringify" };
    }

    if (serialized.length <= this.maxParamChars) {
      return params;
    }

    return {
      _truncated: true,
      original_length: serialized.length,
      preview: serialized.slice(0, this.maxParamChars),
    };
  }

  private stringifyRecord(record: CdpEventLogRecord): string | null {
    try {
      return `${JSON.stringify(record)}\n`;
    } catch {
      return null;
    }
  }
}
