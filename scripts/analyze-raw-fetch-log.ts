import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadCollectorSlackConfig } from "../src/collector-slack/config.js";
import { loadProjectEnv } from "../src/runtime/load-project-env.js";
import {
  deriveSlackNotificationFields,
  sanitizeWorkspaceHost,
} from "../src/collector-slack/notification-derived-fields.js";

loadProjectEnv();

type RawFetchRecord = {
  schema?: string;
  logged_at?: string;
  source?: string;
  kind?: string;
  at?: string;
  payload?: unknown;
};

type CliOptions = {
  filePath: string;
  outputPath?: string;
  sampleLimit: number;
  selfUserIds: string[];
  workspaceHost?: string;
};

type CandidateSummary = {
  line: number;
  at?: string;
  keys: string[];
  matchedReasons: string[];
  payload: unknown;
  derived?: ReturnType<typeof deriveSlackNotificationFields>;
};

const TARGET_KEYS = [
  "team",
  "team_id",
  "channel",
  "channel_id",
  "event_ts",
  "message_ts",
  "thread_ts",
  "permalink",
  "mention_target_user_id",
  "is_direct_mention",
  "title",
  "text",
  "body",
  "notification_type",
] as const;

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.filePath)) {
    printMissingFileGuidance(options.filePath);
    process.exitCode = 1;
    return;
  }
  const lines = readLines(options.filePath);
  const parsed = lines.flatMap((line, index) => {
    try {
      return [{ line: index + 1, record: JSON.parse(line) as RawFetchRecord }];
    } catch {
      return [];
    }
  });
  const inferredWorkspaceHost =
    options.workspaceHost ?? inferWorkspaceHost(parsed.map((entry) => entry.record));

  const candidates: CandidateSummary[] = [];
  const presence = Object.fromEntries(TARGET_KEYS.map((key) => [key, 0])) as Record<string, number>;
  const kindCounts: Record<string, number> = {};

  for (const entry of parsed) {
    const kind = typeof entry.record.kind === "string" ? entry.record.kind : "unknown";
    kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
    const payload = entry.record.payload;
    const keys = collectKeyPaths(payload);
    const keySet = new Set(keys.map((item) => item.split(".").at(-1) ?? item));
    const serialized = safeJson(payload).toLowerCase();
    const matchedReasons = collectMatchedReasons(keySet, serialized);

    for (const key of TARGET_KEYS) {
      if (keySet.has(key)) {
        presence[key] += 1;
      }
    }

    if (matchedReasons.length === 0) {
      continue;
    }
    candidates.push({
      line: entry.line,
      at: entry.record.at,
      keys,
      matchedReasons,
      payload,
      derived: deriveSlackNotificationFields(payload, {
        selfUserIds: options.selfUserIds,
        workspaceHost: inferredWorkspaceHost,
      }),
    });
  }

  const report = {
    filePath: options.filePath,
    workspaceHost: inferredWorkspaceHost,
    selfUserIds: options.selfUserIds,
    totalLines: lines.length,
    parsedRecords: parsed.length,
    kindCounts,
    candidateRecords: candidates.length,
    fieldPresence: presence,
    sampleCandidates: candidates.slice(0, options.sampleLimit),
  };

  console.log(JSON.stringify(report, null, 2));

  if (options.outputPath) {
    writeFileSync(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
}

function printMissingFileGuidance(filePath: string): void {
  console.error(`raw log not found: ${filePath}`);
  console.error("");
  console.error("先に次を実行してください:");
  console.error("1. pnpm rawlog:capture");
  console.error("2. Slack で自分宛メンション通知を1回以上発生");
  console.error("3. pnpm rawlog:analyze");
  console.error("");
  console.error("補足:");
  console.error("- この解析は raw_ws / raw_fetch の両方を含む debug log を対象にします");
  console.error("- 通知がまだ発生していない場合もログファイルは作成されないことがあります");
}

function parseArgs(argv: string[]): CliOptions {
  const config = loadCollectorSlackConfig();
  let filePath =
    process.env.ADJUTANT_RAW_LOG_PATH?.trim() ||
    process.env.ADJUTANT_RAW_FETCH_LOG_PATH?.trim() ||
    join(config.dataDir, "_debug", "slack-debug.jsonl");
  let outputPath: string | undefined;
  let sampleLimit = 5;
  let selfUserIds = parseSelfUserIds(
    process.env.ADJUTANT_SLACK_SELF_USER_IDS,
    process.env.ADJUTANT_SLACK_SELF_USER_ID
  );
  let workspaceHost = sanitizeWorkspaceHost(process.env.ADJUTANT_SLACK_WORKSPACE_HOST?.trim());

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--file") {
      filePath = argv[index + 1] ?? filePath;
      index += 1;
      continue;
    }
    if (current === "--output") {
      outputPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (current === "--sample-limit") {
      const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        sampleLimit = parsed;
      }
      index += 1;
      continue;
    }
    if (current === "--self-user-id") {
      selfUserIds = parseSelfUserIds(argv[index + 1]);
      index += 1;
      continue;
    }
    if (current === "--self-user-ids") {
      selfUserIds = parseSelfUserIds(argv[index + 1]);
      index += 1;
      continue;
    }
    if (current === "--workspace-host") {
      workspaceHost = sanitizeWorkspaceHost(argv[index + 1]) ?? workspaceHost;
      index += 1;
    }
  }

  return {
    filePath: resolve(filePath),
    outputPath: outputPath ? resolve(outputPath) : undefined,
    sampleLimit,
    selfUserIds,
    workspaceHost,
  };
}

function parseSelfUserIds(...values: Array<string | undefined>): string[] {
  const ids = new Set<string>();
  for (const raw of values) {
    if (!raw) {
      continue;
    }
    for (const part of raw.split(",")) {
      const value = part.trim();
      if (value) {
        ids.add(value);
      }
    }
  }
  return Array.from(ids);
}

function readLines(filePath: string): string[] {
  const raw = readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function collectKeyPaths(value: unknown, prefix = "", depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectKeyPaths(item, `${prefix}[${index}]`, depth + 1));
  }
  if (typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  const keys: string[] = [];
  for (const [key, nested] of Object.entries(record)) {
    const path = prefix ? `${prefix}.${key}` : key;
    keys.push(path);
    keys.push(...collectKeyPaths(nested, path, depth + 1));
  }
  return keys;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function collectMatchedReasons(keySet: Set<string>, serialized: string): string[] {
  const reasons: string[] = [];
  const tokens = [
    "notification",
    "mention",
    "desktop_notification",
    "mention_notification",
    "body",
    "title",
    "event_ts",
    "team_id",
  ];
  for (const token of tokens) {
    if (serialized.includes(token)) {
      reasons.push(`text:${token}`);
    }
  }
  for (const key of TARGET_KEYS) {
    if (keySet.has(key)) {
      reasons.push(`key:${key}`);
    }
  }
  return reasons;
}

function inferWorkspaceHost(records: RawFetchRecord[]): string | undefined {
  for (const record of records) {
    if (record.kind !== "session_start") {
      continue;
    }
    const payload = record.payload as { workspace_host?: unknown } | undefined;
    const workspaceHost = sanitizeWorkspaceHost(
      typeof payload?.workspace_host === "string" ? payload.workspace_host : undefined
    );
    if (workspaceHost) {
      return workspaceHost;
    }
  }
  return undefined;
}
