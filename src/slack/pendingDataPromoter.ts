import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { withJsonlChecksum } from "../io/jsonl-checksum.js";
import { normalizeAccountId } from "../runtime/data-paths.js";
import { SLACK_PENDING_ACCOUNT_ID } from "./slackAuthTokenStore.js";

const TEAM_ID_RE = /^T[A-Z0-9]{2,}$/i;

type JsonRecord = Record<string, unknown>;

type TeamCacheKind = "channel-names-by-team" | "user-names-by-team";

export type PendingDataPromotionInput = {
  workspaceKey: string;
  accountId: string;
  teamId?: string;
  aliases?: string[];
};

export type PendingDataPromotionResult = {
  movedEventLines: number;
  movedChannelCacheTeams: string[];
  movedUserCacheTeams: string[];
  movedRoutePins: string[];
  skippedEventLines: number;
};

export type PendingDataPromoterOptions = {
  dataDir: string;
  now?: () => Date;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
};

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function toJsonObject(value: unknown): JsonRecord | null {
  const record = asRecord(value);
  return record ? { ...record } : null;
}

function dedupeAliases(input: {
  workspaceKey: string;
  aliases: string[];
  teamId?: string;
}): string[] {
  const deduped = new Set<string>();
  deduped.add(input.workspaceKey);
  if (input.teamId) {
    deduped.add(input.teamId);
  }
  for (const alias of input.aliases) {
    const normalized = asString(alias);
    if (normalized) {
      deduped.add(normalized);
    }
  }
  return [...deduped];
}

function isSlackEventFile(filePath: string): boolean {
  if (basename(filePath) !== "events.jsonl") {
    return false;
  }
  return basename(dirname(filePath)) === "slack";
}

async function listFilesRecursively(dirPath: string): Promise<string[]> {
  let entries: Array<import("node:fs").Dirent> = [];
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(fullPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

async function readLines(filePath: string): Promise<string[]> {
  const readline = await import("node:readline");
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const lines: string[] = [];
  for await (const line of rl) {
    lines.push(line);
  }
  return lines;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const target = await stat(filePath);
    return target.isFile();
  } catch {
    return false;
  }
}

function parseRoutePins(
  raw: string
): Array<{ workspaceKey: string; mode: "team" | "enterprise"; decidedAt: number }> {
  try {
    const parsed = JSON.parse(raw) as { pins?: unknown };
    const pinsRaw = Array.isArray(parsed.pins) ? parsed.pins : [];
    const pins: Array<{ workspaceKey: string; mode: "team" | "enterprise"; decidedAt: number }> =
      [];
    for (const item of pinsRaw) {
      const record = asRecord(item);
      if (!record) {
        continue;
      }
      const workspaceKey = asString(record.workspaceKey);
      const mode = record.mode === "team" || record.mode === "enterprise" ? record.mode : undefined;
      const decidedAt =
        typeof record.decidedAt === "number" && Number.isFinite(record.decidedAt)
          ? Math.floor(record.decidedAt)
          : undefined;
      if (!workspaceKey || !mode || decidedAt === undefined) {
        continue;
      }
      pins.push({ workspaceKey, mode, decidedAt });
    }
    return pins;
  } catch {
    return [];
  }
}

function parseChannelCache(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as { channels?: unknown };
    const channelsRaw = asRecord(parsed.channels);
    if (!channelsRaw) {
      return {};
    }
    const channels: Record<string, string> = {};
    for (const [channelId, name] of Object.entries(channelsRaw)) {
      const channelName = asString(name);
      if (!channelName) {
        continue;
      }
      channels[channelId] = channelName;
    }
    return channels;
  } catch {
    return {};
  }
}

function parseUserCache(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as { users?: unknown };
    const usersRaw = asRecord(parsed.users);
    if (!usersRaw) {
      return {};
    }
    return usersRaw;
  } catch {
    return {};
  }
}

export class PendingDataPromoter {
  private readonly dataDir: string;
  private readonly now: () => Date;
  private readonly onWarn?: (message: string, meta?: Record<string, unknown>) => void;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: PendingDataPromoterOptions) {
    this.dataDir = resolve(options.dataDir);
    this.now = options.now ?? (() => new Date());
    this.onWarn = options.onWarn;
  }

  async promoteByWorkspace(input: PendingDataPromotionInput): Promise<PendingDataPromotionResult> {
    const workspaceKey = asString(input.workspaceKey);
    const accountIdRaw = asString(input.accountId);
    if (!workspaceKey || !accountIdRaw) {
      return {
        movedEventLines: 0,
        movedChannelCacheTeams: [],
        movedUserCacheTeams: [],
        movedRoutePins: [],
        skippedEventLines: 0,
      };
    }

    const teamId = asString(input.teamId);
    const accountId = normalizeAccountId(accountIdRaw, "default");
    const aliases = dedupeAliases({
      workspaceKey,
      aliases: Array.isArray(input.aliases) ? input.aliases : [],
      teamId,
    });
    const aliasSet = new Set<string>(aliases);
    const teamIds = new Set<string>();
    for (const alias of aliases) {
      if (TEAM_ID_RE.test(alias)) {
        teamIds.add(alias);
      }
    }
    if (teamId) {
      teamIds.add(teamId);
    }

    const runPromotion = async (): Promise<PendingDataPromotionResult> => {
      const result: PendingDataPromotionResult = {
        movedEventLines: 0,
        movedChannelCacheTeams: [],
        movedUserCacheTeams: [],
        movedRoutePins: [],
        skippedEventLines: 0,
      };

      const pendingAccountDir = this.pendingAccountDir();
      const accountDir = this.accountDir(accountId);

      const eventResult = await this.promoteEvents({
        pendingAccountDir,
        accountDir,
        accountId,
        aliasSet,
      });
      result.movedEventLines += eventResult.moved;
      result.skippedEventLines += eventResult.skipped;

      const movedChannelTeams = await this.promoteTeamCacheKind({
        pendingAccountDir,
        accountDir,
        teamIds,
        kind: "channel-names-by-team",
      });
      result.movedChannelCacheTeams.push(...movedChannelTeams);

      const movedUserTeams = await this.promoteTeamCacheKind({
        pendingAccountDir,
        accountDir,
        teamIds,
        kind: "user-names-by-team",
      });
      result.movedUserCacheTeams.push(...movedUserTeams);

      const movedPins = await this.promoteRoutePins({
        pendingAccountDir,
        accountDir,
        aliasSet,
      });
      result.movedRoutePins.push(...movedPins);

      return result;
    };

    const resultPromise = this.queue.then(runPromotion, runPromotion);
    this.queue = resultPromise.then(
      () => undefined,
      () => undefined
    );
    return resultPromise;
  }

  private pendingAccountDir(): string {
    return join(this.dataDir, "accounts", SLACK_PENDING_ACCOUNT_ID);
  }

  private accountDir(accountId: string): string {
    return join(this.dataDir, "accounts", normalizeAccountId(accountId, "default"));
  }

  private async promoteEvents(input: {
    pendingAccountDir: string;
    accountDir: string;
    accountId: string;
    aliasSet: Set<string>;
  }): Promise<{ moved: number; skipped: number }> {
    const files = (await listFilesRecursively(input.pendingAccountDir)).filter(isSlackEventFile);
    let moved = 0;
    let skipped = 0;

    for (const sourcePath of files) {
      const relativePath = relative(input.pendingAccountDir, sourcePath);
      if (relativePath.startsWith("..")) {
        continue;
      }
      const targetPath = join(input.accountDir, relativePath);
      const targetUidSet = await this.collectEventUids(targetPath);
      const sourceLines = await readLines(sourcePath);

      const keepLines: string[] = [];
      const moveLines: string[] = [];
      let removedLineCount = 0;

      for (const line of sourceLines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          keepLines.push(line);
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          this.warn("pending-data-promoter-event-parse-failed", { sourcePath });
          keepLines.push(line);
          skipped += 1;
          continue;
        }

        const eventRecord = toJsonObject(parsed);
        if (!eventRecord) {
          this.warn("pending-data-promoter-event-record-invalid", { sourcePath });
          keepLines.push(line);
          skipped += 1;
          continue;
        }
        if (!this.shouldPromoteEvent(eventRecord, input.aliasSet)) {
          keepLines.push(line);
          continue;
        }

        const normalized = this.rewriteEventAccount(eventRecord, input.accountId);
        const uid = asString(normalized.uid);
        if (uid && targetUidSet.has(uid)) {
          removedLineCount += 1;
          continue;
        }
        if (uid) {
          targetUidSet.add(uid);
        }

        moveLines.push(`${JSON.stringify(withJsonlChecksum(normalized))}\n`);
        moved += 1;
        removedLineCount += 1;
      }

      if (moveLines.length > 0) {
        await mkdir(dirname(targetPath), { recursive: true });
        await appendFile(targetPath, moveLines.join(""), "utf8");
      }

      if (removedLineCount > 0) {
        if (keepLines.length === 0) {
          await unlink(sourcePath).catch(() => undefined);
        } else {
          await writeFile(sourcePath, `${keepLines.join("\n")}\n`, "utf8");
        }
      }
    }

    return { moved, skipped };
  }

  private async collectEventUids(filePath: string): Promise<Set<string>> {
    if (!(await fileExists(filePath))) {
      return new Set<string>();
    }
    const lines = await readLines(filePath);
    const uidSet = new Set<string>();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as { uid?: unknown };
        const uid = asString(parsed.uid);
        if (uid) {
          uidSet.add(uid);
        }
      } catch {
        // broken line in destination file should not block promotion
      }
    }
    return uidSet;
  }

  private shouldPromoteEvent(eventRecord: JsonRecord, aliasSet: Set<string>): boolean {
    const meta = asRecord(eventRecord.meta);
    if (!meta) {
      return false;
    }
    const workspaceKey = asString(meta.workspace_key);
    if (workspaceKey && aliasSet.has(workspaceKey)) {
      return true;
    }
    const teamId = asString(meta.team_id);
    if (teamId && aliasSet.has(teamId)) {
      return true;
    }
    return false;
  }

  private rewriteEventAccount(eventRecord: JsonRecord, accountId: string): JsonRecord {
    const meta = asRecord(eventRecord.meta) ?? {};
    return {
      ...eventRecord,
      meta: {
        ...meta,
        account_id: accountId,
      },
    };
  }

  private async promoteTeamCacheKind(input: {
    pendingAccountDir: string;
    accountDir: string;
    teamIds: Set<string>;
    kind: TeamCacheKind;
  }): Promise<string[]> {
    const movedTeams: string[] = [];
    if (input.teamIds.size === 0) {
      return movedTeams;
    }

    const sourceDir = join(input.pendingAccountDir, "_cache", "slack", input.kind);
    const targetDir = join(input.accountDir, "_cache", "slack", input.kind);
    const nowIso = this.now().toISOString();

    for (const teamId of input.teamIds) {
      const sourcePath = join(sourceDir, `${teamId}.json`);
      if (!(await fileExists(sourcePath))) {
        continue;
      }

      const sourceRaw = await readFile(sourcePath, "utf8").catch(() => null);
      if (!sourceRaw) {
        this.warn("pending-data-promoter-cache-read-failed", { sourcePath, kind: input.kind });
        continue;
      }
      const targetPath = join(targetDir, `${teamId}.json`);
      const targetRaw = await readFile(targetPath, "utf8").catch(() => null);

      if (input.kind === "channel-names-by-team") {
        const mergedChannels = {
          ...parseChannelCache(targetRaw ?? "{}"),
          ...parseChannelCache(sourceRaw),
        };
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(
          targetPath,
          `${JSON.stringify(
            {
              schema: "adjutant.slack.channel-cache.v1",
              updated_at: nowIso,
              team_id: teamId,
              channels: mergedChannels,
            },
            null,
            2
          )}\n`,
          "utf8"
        );
      } else {
        const mergedUsers = {
          ...parseUserCache(targetRaw ?? "{}"),
          ...parseUserCache(sourceRaw),
        };
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(
          targetPath,
          `${JSON.stringify(
            {
              schema: "adjutant.slack.user-cache.v2",
              updated_at: nowIso,
              team_id: teamId,
              users: mergedUsers,
            },
            null,
            2
          )}\n`,
          "utf8"
        );
      }

      await unlink(sourcePath).catch(() => undefined);
      movedTeams.push(teamId);
    }

    return movedTeams;
  }

  private async promoteRoutePins(input: {
    pendingAccountDir: string;
    accountDir: string;
    aliasSet: Set<string>;
  }): Promise<string[]> {
    const sourcePath = join(
      input.pendingAccountDir,
      "_cache",
      "slack",
      "workspace-route-pins.json"
    );
    if (!(await fileExists(sourcePath))) {
      return [];
    }

    const sourceRaw = await readFile(sourcePath, "utf8").catch(() => null);
    if (!sourceRaw) {
      this.warn("pending-data-promoter-route-pins-read-failed", { sourcePath });
      return [];
    }
    const sourcePins = parseRoutePins(sourceRaw);
    if (sourcePins.length === 0) {
      return [];
    }

    const promoted = sourcePins.filter((pin) => input.aliasSet.has(pin.workspaceKey));
    if (promoted.length === 0) {
      return [];
    }

    const targetPath = join(input.accountDir, "_cache", "slack", "workspace-route-pins.json");
    const targetRaw = await readFile(targetPath, "utf8").catch(() => null);
    const targetPins = parseRoutePins(targetRaw ?? "{}");
    const mergedMap = new Map<
      string,
      { workspaceKey: string; mode: "team" | "enterprise"; decidedAt: number }
    >();

    for (const pin of targetPins) {
      mergedMap.set(pin.workspaceKey, pin);
    }
    for (const pin of promoted) {
      const current = mergedMap.get(pin.workspaceKey);
      if (!current || pin.decidedAt >= current.decidedAt) {
        mergedMap.set(pin.workspaceKey, pin);
      }
    }

    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(
      targetPath,
      `${JSON.stringify(
        {
          schema: "adjutant.slack.workspace-route-pin.v1",
          updatedAt: this.now().toISOString(),
          pins: [...mergedMap.values()],
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const promotedKeys = new Set(promoted.map((pin) => pin.workspaceKey));
    const remained = sourcePins.filter((pin) => !promotedKeys.has(pin.workspaceKey));
    if (remained.length === 0) {
      await unlink(sourcePath).catch(() => undefined);
    } else {
      await writeFile(
        sourcePath,
        `${JSON.stringify(
          {
            schema: "adjutant.slack.workspace-route-pin.v1",
            updatedAt: this.now().toISOString(),
            pins: remained,
          },
          null,
          2
        )}\n`,
        "utf8"
      );
    }

    return [...promotedKeys];
  }

  private warn(message: string, meta?: Record<string, unknown>): void {
    this.onWarn?.(message, meta);
  }
}
