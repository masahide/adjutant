import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

export type SlackNameCacheRepositoryOptions = {
  channelCachePath?: string;
  userCachePath?: string;
  now?: () => Date;
};

type TeamChange = {
  teamId: string;
  changed: number;
  total: number;
};

export class SlackNameCacheRepository {
  private readonly channelNamesByTeam: Map<string, Map<string, string>> = new Map();
  private readonly userNamesByTeam: Map<string, Map<string, string>> = new Map();
  private readonly channelTeamIds: Map<string, Set<string>> = new Map();
  private readonly now: () => Date;
  private readonly channelCachePath: string | undefined;
  private readonly userCachePath: string | undefined;

  constructor(options: SlackNameCacheRepositoryOptions = {}) {
    this.channelCachePath = options.channelCachePath;
    this.userCachePath = options.userCachePath;
    this.now = options.now ?? (() => new Date());
  }

  async load(): Promise<void> {
    await Promise.all([this.loadChannelCache(), this.loadUserCache()]);
  }

  resolveTeam(
    teamIdHint: string | undefined,
    channelId: string | null | undefined
  ): string | undefined {
    const normalizedTeamId = teamIdHint?.trim();
    if (normalizedTeamId) return normalizedTeamId;
    const normalizedChannelId = channelId?.trim();
    if (!normalizedChannelId) return undefined;
    const teams = this.channelTeamIds.get(normalizedChannelId);
    if (!teams || teams.size !== 1) return undefined;
    return Array.from(teams)[0];
  }

  resolveChannelName(
    channelId: string | null | undefined,
    teamIdHint: string | undefined
  ): string | undefined {
    const normalizedChannelId = channelId?.trim();
    if (!normalizedChannelId) return undefined;

    const teamId = this.resolveTeam(teamIdHint, normalizedChannelId);
    if (teamId) {
      return this.channelNamesByTeam.get(teamId)?.get(normalizedChannelId);
    }

    let found: string | undefined;
    for (const teamMap of this.channelNamesByTeam.values()) {
      const candidate = teamMap.get(normalizedChannelId);
      if (!candidate) continue;
      if (found && found !== candidate) return undefined;
      found = candidate;
    }
    return found;
  }

  resolveUserName(
    userId: string | null | undefined,
    teamIdHint: string | undefined,
    channelIdHint?: string | null | undefined
  ): string | undefined {
    const normalizedUserId = userId?.trim();
    if (!normalizedUserId) return undefined;

    const teamId = this.resolveTeam(teamIdHint, channelIdHint);
    if (teamId) {
      return this.userNamesByTeam.get(teamId)?.get(normalizedUserId);
    }

    let found: string | undefined;
    for (const teamMap of this.userNamesByTeam.values()) {
      const candidate = teamMap.get(normalizedUserId);
      if (!candidate) continue;
      if (found && found !== candidate) return undefined;
      found = candidate;
    }
    return found;
  }

  async updateChannel(
    teamId: string,
    channelId: string,
    channelName: string
  ): Promise<TeamChange | null> {
    const normalizedTeamId = teamId.trim();
    const normalizedChannelId = channelId.trim();
    const normalizedChannelName = channelName.trim();
    if (!normalizedTeamId || !normalizedChannelId || !normalizedChannelName) return null;

    let teamMap = this.channelNamesByTeam.get(normalizedTeamId);
    if (!teamMap) {
      teamMap = new Map<string, string>();
      this.channelNamesByTeam.set(normalizedTeamId, teamMap);
    }

    const before = teamMap.get(normalizedChannelId);
    if (before === normalizedChannelName) return null;

    teamMap.set(normalizedChannelId, normalizedChannelName);
    this.addChannelTeam(normalizedChannelId, normalizedTeamId);
    await this.persistChannelCache(normalizedTeamId, teamMap);
    return { teamId: normalizedTeamId, changed: 1, total: teamMap.size };
  }

  async updateUsers(
    users: Array<{ teamId: string; userId: string; userName: string }>
  ): Promise<TeamChange[]> {
    const changedCounts = new Map<string, number>();

    for (const user of users) {
      const teamId = user.teamId.trim();
      const userId = user.userId.trim();
      const userName = user.userName.trim();
      if (!teamId || !userId || !userName) continue;

      let teamMap = this.userNamesByTeam.get(teamId);
      if (!teamMap) {
        teamMap = new Map<string, string>();
        this.userNamesByTeam.set(teamId, teamMap);
      }

      const before = teamMap.get(userId);
      if (before === userName) continue;
      teamMap.set(userId, userName);
      changedCounts.set(teamId, (changedCounts.get(teamId) ?? 0) + 1);
    }

    const updates: TeamChange[] = [];
    for (const [teamId, changed] of changedCounts.entries()) {
      const teamMap = this.userNamesByTeam.get(teamId);
      if (!teamMap) continue;
      await this.persistUserCache(teamId, teamMap);
      updates.push({ teamId, changed, total: teamMap.size });
    }

    return updates;
  }

  private async loadChannelCache(): Promise<void> {
    const filePath = this.channelCachePath;
    if (!filePath) return;

    const teamDir = this.toTeamCacheDir(filePath);
    try {
      const files = await readdir(teamDir);
      for (const name of files) {
        if (!name.endsWith(".json")) continue;
        const teamId = basename(name, ".json");
        if (!teamId) continue;

        const raw = await readFile(join(teamDir, name), "utf8");
        const parsed = JSON.parse(raw) as { channels?: Record<string, string> };
        const channels = parsed.channels ?? {};
        for (const [channelId, channelName] of Object.entries(channels)) {
          if (typeof channelName !== "string" || !channelName.trim()) continue;

          let teamMap = this.channelNamesByTeam.get(teamId);
          if (!teamMap) {
            teamMap = new Map<string, string>();
            this.channelNamesByTeam.set(teamId, teamMap);
          }
          teamMap.set(channelId, channelName.trim());
          this.addChannelTeam(channelId, teamId);
        }
      }
    } catch {
      // missing/broken cache should not break ingestion
    }
  }

  private async loadUserCache(): Promise<void> {
    const filePath = this.userCachePath;
    if (!filePath) return;

    const teamDir = this.toTeamCacheDir(filePath);
    try {
      const files = await readdir(teamDir);
      for (const name of files) {
        if (!name.endsWith(".json")) continue;
        const teamId = basename(name, ".json");
        if (!teamId) continue;

        const raw = await readFile(join(teamDir, name), "utf8");
        const parsed = JSON.parse(raw) as { users?: Record<string, string> };
        const users = parsed.users ?? {};
        for (const [userId, userName] of Object.entries(users)) {
          if (typeof userName !== "string" || !userName.trim()) continue;

          let teamMap = this.userNamesByTeam.get(teamId);
          if (!teamMap) {
            teamMap = new Map<string, string>();
            this.userNamesByTeam.set(teamId, teamMap);
          }
          teamMap.set(userId, userName.trim());
        }
      }
    } catch {
      // missing/broken cache should not break ingestion
    }
  }

  private async persistChannelCache(teamId: string, channels: Map<string, string>): Promise<void> {
    const filePath = this.channelCachePath;
    if (!filePath) return;

    const teamDir = this.toTeamCacheDir(filePath);
    const target = join(teamDir, `${teamId}.json`);
    const payload = {
      schema: "adjutant.slack.channel-cache.v1",
      updated_at: this.now().toISOString(),
      team_id: teamId,
      channels: Object.fromEntries(channels.entries()),
    };

    try {
      await mkdir(teamDir, { recursive: true });
      await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    } catch {
      // ignore write failures
    }
  }

  private async persistUserCache(teamId: string, users: Map<string, string>): Promise<void> {
    const filePath = this.userCachePath;
    if (!filePath) return;

    const teamDir = this.toTeamCacheDir(filePath);
    const target = join(teamDir, `${teamId}.json`);
    const payload = {
      schema: "adjutant.slack.user-cache.v1",
      updated_at: this.now().toISOString(),
      team_id: teamId,
      users: Object.fromEntries(users.entries()),
    };

    try {
      await mkdir(teamDir, { recursive: true });
      await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    } catch {
      // ignore write failures
    }
  }

  private toTeamCacheDir(filePath: string): string {
    const ext = extname(filePath);
    if (!ext) return filePath;
    return join(dirname(filePath), basename(filePath, ext));
  }

  private addChannelTeam(channelId: string, teamId: string): void {
    const normalizedChannelId = channelId.trim();
    const normalizedTeamId = teamId.trim();
    if (!normalizedChannelId || !normalizedTeamId) return;
    let teams = this.channelTeamIds.get(normalizedChannelId);
    if (!teams) {
      teams = new Set<string>();
      this.channelTeamIds.set(normalizedChannelId, teams);
    }
    teams.add(normalizedTeamId);
  }
}
