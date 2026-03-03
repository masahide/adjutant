import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type UserProfile = {
  display_name?: string;
  real_name?: string;
};

type UserRecord = {
  real_name?: string;
  profile?: {
    display_name?: string;
  };
};

export type SlackNameCacheRepositoryOptions = {
  baseDir: string;
  now?: () => Date;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringMap(value: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!isObject(value)) {
    return map;
  }
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string" && raw.trim().length > 0) {
      map.set(key, raw.trim());
    }
  }
  return map;
}

function pickUserName(record: UserProfile | UserRecord | undefined): string | undefined {
  if (!record) {
    return undefined;
  }
  const directDisplay =
    "display_name" in record && typeof record.display_name === "string"
      ? record.display_name.trim()
      : undefined;
  if (directDisplay) {
    return directDisplay;
  }
  const profileDisplay =
    "profile" in record &&
    isObject(record.profile) &&
    typeof record.profile.display_name === "string"
      ? record.profile.display_name.trim()
      : undefined;
  const display = profileDisplay;
  if (display) {
    return display;
  }
  const real = record.real_name?.trim();
  if (real) {
    return real;
  }
  return undefined;
}

export class SlackNameCacheRepository {
  private readonly now: () => Date;
  private readonly channelDir: string;
  private readonly userDir: string;
  private readonly channelNamesByTeam = new Map<string, Map<string, string>>();
  private readonly userNamesByTeam = new Map<string, Map<string, UserProfile>>();
  private readonly dirtyChannelTeams = new Set<string>();
  private readonly dirtyUserTeams = new Set<string>();

  constructor(private readonly options: SlackNameCacheRepositoryOptions) {
    this.now = options.now ?? (() => new Date());
    this.channelDir = join(options.baseDir, "channel-names-by-team");
    this.userDir = join(options.baseDir, "user-names-by-team");
  }

  load(): void {
    this.channelNamesByTeam.clear();
    this.userNamesByTeam.clear();
    this.loadChannelCaches();
    this.loadUserCaches();
  }

  persist(): void {
    mkdirSync(this.channelDir, { recursive: true });
    mkdirSync(this.userDir, { recursive: true });

    const nowIso = this.now().toISOString();

    for (const teamId of this.dirtyChannelTeams) {
      const channels = this.channelNamesByTeam.get(teamId) ?? new Map<string, string>();
      const payload = {
        schema: "adjutant.slack.channel-cache.v1",
        updated_at: nowIso,
        team_id: teamId,
        channels: Object.fromEntries(channels.entries()),
      };
      writeFileSync(
        join(this.channelDir, `${teamId}.json`),
        JSON.stringify(payload, null, 2),
        "utf8"
      );
    }

    for (const teamId of this.dirtyUserTeams) {
      const users = this.userNamesByTeam.get(teamId) ?? new Map<string, UserProfile>();
      const payload = {
        schema: "adjutant.slack.user-cache.v2",
        updated_at: nowIso,
        team_id: teamId,
        users: Object.fromEntries(
          [...users.entries()].map(([userId, profile]) => [
            userId,
            {
              real_name: profile.real_name,
              profile: {
                display_name: profile.display_name,
              },
            },
          ])
        ),
      };
      writeFileSync(join(this.userDir, `${teamId}.json`), JSON.stringify(payload, null, 2), "utf8");
    }

    this.dirtyChannelTeams.clear();
    this.dirtyUserTeams.clear();
  }

  setChannelName(teamId: string, channelId: string, channelName: string): void {
    if (!teamId || !channelId || !channelName) {
      return;
    }
    const channels = this.channelNamesByTeam.get(teamId) ?? new Map<string, string>();
    channels.set(channelId, channelName);
    this.channelNamesByTeam.set(teamId, channels);
    this.dirtyChannelTeams.add(teamId);
  }

  setUserProfile(teamId: string, userId: string, profile: UserProfile): void {
    if (!teamId || !userId) {
      return;
    }
    const users = this.userNamesByTeam.get(teamId) ?? new Map<string, UserProfile>();
    users.set(userId, profile);
    this.userNamesByTeam.set(teamId, users);
    this.dirtyUserTeams.add(teamId);
  }

  resolveChannelName(channelId: string, teamIdHint?: string): string | undefined {
    if (!channelId) {
      return undefined;
    }
    if (teamIdHint) {
      return this.channelNamesByTeam.get(teamIdHint)?.get(channelId);
    }
    for (const channels of this.channelNamesByTeam.values()) {
      const matched = channels.get(channelId);
      if (matched !== undefined) {
        return matched;
      }
    }
    return undefined;
  }

  resolveUserName(userId: string, teamIdHint?: string): string | undefined {
    if (!userId) {
      return undefined;
    }
    if (teamIdHint) {
      const user = this.userNamesByTeam.get(teamIdHint)?.get(userId);
      return pickUserName(user);
    }
    for (const users of this.userNamesByTeam.values()) {
      const user = users.get(userId);
      const resolved = pickUserName(user);
      if (resolved !== undefined) {
        return resolved;
      }
    }
    return undefined;
  }

  private loadChannelCaches(): void {
    try {
      const entries = readdirSync(this.channelDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }
        const fullPath = join(this.channelDir, entry.name);
        try {
          const parsed = JSON.parse(readFileSync(fullPath, "utf8")) as Record<string, unknown>;
          const teamId =
            typeof parsed.team_id === "string"
              ? parsed.team_id
              : entry.name.slice(0, Math.max(0, entry.name.length - ".json".length));
          this.channelNamesByTeam.set(teamId, toStringMap(parsed.channels));
        } catch {
          // ignore malformed cache file
        }
      }
    } catch {
      // no cache directory yet
    }
  }

  private loadUserCaches(): void {
    try {
      const entries = readdirSync(this.userDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }
        const fullPath = join(this.userDir, entry.name);
        try {
          const parsed = JSON.parse(readFileSync(fullPath, "utf8")) as Record<string, unknown>;
          const teamId =
            typeof parsed.team_id === "string"
              ? parsed.team_id
              : entry.name.slice(0, Math.max(0, entry.name.length - ".json".length));

          const users = new Map<string, UserProfile>();
          const usersRaw = parsed.users;
          if (isObject(usersRaw)) {
            for (const [userId, value] of Object.entries(usersRaw)) {
              if (!isObject(value)) {
                continue;
              }
              const realName = typeof value.real_name === "string" ? value.real_name : undefined;
              const profileRaw = isObject(value.profile) ? value.profile : {};
              const displayName =
                typeof profileRaw.display_name === "string" ? profileRaw.display_name : undefined;
              users.set(userId, {
                real_name: realName,
                display_name: displayName,
              });
            }
          }
          this.userNamesByTeam.set(teamId, users);
        } catch {
          // ignore malformed cache file
        }
      }
    } catch {
      // no cache directory yet
    }
  }
}
