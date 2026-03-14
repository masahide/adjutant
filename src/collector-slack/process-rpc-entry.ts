import { join } from "node:path";

import type { CollectorIngestRequest } from "../contracts/process-rpc/method-types.js";
import type { NormalizedEvent } from "../core/events.js";
import { loadCollectorSlackConfig } from "./config.js";
import {
  enrichNotificationEvent,
  isDirectMentionNotificationEvent,
  normalizeDirectMentionNotificationFromRawPayload,
} from "./notification-events.js";
import {
  deriveTeamIdFromPayload,
  maybeLearnWorkspaceHostFromFetchPayload,
  resolveWorkspaceHostForTeam,
} from "./notification-derived-fields.js";
import { SelfActivityStore } from "./self-activity-store.js";
import { connectToSlackPage } from "../../legacy/impl-20260228/src/runtime/slackConnection.js";
import { SlackAdapter } from "../../legacy/impl-20260228/src/slack/adapter.js";

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: unknown;
};

class CollectorProcessRpcEmitter {
  private requestSequence = 0;

  emit(event: NormalizedEvent): void {
    const request = this.buildRequest(event);
    process.stdout.write(`${JSON.stringify(request)}\n`);
  }

  private buildRequest(event: NormalizedEvent): {
    jsonrpc: "2.0";
    id: string;
    method: "collector/ingest";
    params: CollectorIngestRequest;
  } {
    this.requestSequence += 1;
    return {
      jsonrpc: "2.0",
      id: `collector_ingest_${this.requestSequence}`,
      method: "collector/ingest",
      params: {
        messageId: event.uid,
        dedupeKey: event.uid,
        source: "slack",
        payload: event,
        occurredAt: event.logged_at ?? event.ts,
      },
    };
  }
}

function parseSelfUserIds(): string[] {
  const values = new Set<string>();
  for (const raw of [
    process.env.ADJUTANT_SLACK_SELF_USER_IDS,
    process.env.ADJUTANT_SLACK_SELF_USER_ID,
  ]) {
    if (!raw) {
      continue;
    }
    for (const part of raw.split(",")) {
      const value = part.trim();
      if (value) {
        values.add(value);
      }
    }
  }
  return Array.from(values);
}

async function main(): Promise<void> {
  const config = loadCollectorSlackConfig();
  const { host, port } = config.endpoint;
  const selfUserIds = parseSelfUserIds();
  const timezone = process.env.ADJUTANT_TZ?.trim() || "Asia/Tokyo";
  const channelCachePath = join(config.dataDir, "_cache", "slack", "channel-names-by-team.json");
  const userCachePath = join(config.dataDir, "_cache", "slack", "user-names-by-team.json");
  const { client, slackUrl } = await connectToSlackPage(host, port);
  const defaultWorkspaceHost = new URL(slackUrl).host;
  const workspaceHostsByTeam = new Map<string, string>(
    Object.entries(config.workspaceHostsByTeam ?? {})
  );
  const emitter = new CollectorProcessRpcEmitter();
  const selfActivityStore = new SelfActivityStore({ dataDir: config.dataDir });
  const seenUids = new Set<string>();

  const maybeEmit = (event: NormalizedEvent | undefined): void => {
    if (!event) {
      return;
    }
    if (event.kind === "notification" && !isDirectMentionNotificationEvent(event)) {
      return;
    }
    if (seenUids.has(event.uid)) {
      return;
    }
    seenUids.add(event.uid);
    emitter.emit(event);
  };

  const adapter = new SlackAdapter({
    client,
    now: () => new Date(),
    timezone,
    domCaptureDisabled: config.disableDomCapture,
    channelCachePath,
    userCachePath,
    debugFetchHookEnabled: false,
    onDebugEvent: (event) => {
      if (event.kind === "raw_fetch") {
        maybeLearnWorkspaceHostFromFetchPayload(event.payload, workspaceHostsByTeam);
        return;
      }
      if (event.kind !== "raw_ws") {
        return;
      }
      const normalized = normalizeDirectMentionNotificationFromRawPayload(event.payload, {
        selfUserIds,
        workspaceHost: resolveWorkspaceHostForTeam({
          payload: event.payload,
          teamId: deriveTeamIdFromPayload(event.payload),
          workspaceHostsByTeam,
          fallbackHost: defaultWorkspaceHost,
        }),
        workspaceHostsByTeam,
        timezone,
        now: new Date(event.at),
      });
      maybeEmit(normalized);
    },
  });

  const shutdown = async () => {
    await adapter.stop();
    await client.close();
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string | Buffer) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines = text
      .split("\n")
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0);
    for (const line of lines) {
      try {
        JSON.parse(line) as JsonRpcResponse;
      } catch {
        // ignore non-JSON parent output
      }
    }
  });

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  await adapter.start(async (event) => {
    const teamId =
      event.detail && typeof event.detail === "object" && "slack" in event.detail
        ? deriveTeamIdFromPayload(event.detail.slack)
        : undefined;
    const normalized = enrichNotificationEvent(event as NormalizedEvent, {
      selfUserIds,
      workspaceHost: resolveWorkspaceHostForTeam({
        payload: event,
        teamId,
        workspaceHostsByTeam,
        fallbackHost: defaultWorkspaceHost,
      }),
      workspaceHostsByTeam,
    });
    if (normalized.kind === "post" || normalized.kind === "reaction") {
      await selfActivityStore.append(normalized);
      return;
    }
    maybeEmit(normalized);
  });
}

void main().catch((error) => {
  console.error("[collector-slack] fatal:", error);
  process.exit(1);
});
