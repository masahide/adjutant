import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

export type SlackNameCacheRepositoryOptions = {
  channelCachePath?: string;
  userCachePath?: string;
  now?: () => Date;
};

export type SlackUserProfile = {
  real_name?: string;
  profile?: {
    display_name?: string;
    email?: string;
    first_name?: string;
    last_name?: string;
    image_original?: string;
  };
};

type TeamChange = {
  teamId: string;
  changed: number;
  total: number;
};

export class SlackNameCacheRepository {
  private readonly channelNamesByTeam: Map<string, Map<string, string>> = new Map();
  private readonly userNamesByTeam: Map<string, Map<string, string>> = new Map();
  private readonly userProfilesByTeam: Map<string, Map<string, SlackUserProfile>> = new Map();
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
    const changes = await this.updateChannels([{ teamId, channelId, channelName }]);
    return changes.length > 0 ? changes[0] : null;
  }

  async updateChannels(
    channels: Array<{ teamId: string; channelId: string; channelName: string }>
  ): Promise<TeamChange[]> {
    const changedCounts = new Map<string, number>();

    for (const channel of channels) {
      const normalizedTeamId = channel.teamId.trim();
      const normalizedChannelId = channel.channelId.trim();
      const normalizedChannelName = channel.channelName.trim();
      if (!normalizedTeamId || !normalizedChannelId || !normalizedChannelName) continue;

      let teamMap = this.channelNamesByTeam.get(normalizedTeamId);
      if (!teamMap) {
        teamMap = new Map<string, string>();
        this.channelNamesByTeam.set(normalizedTeamId, teamMap);
      }

      const before = teamMap.get(normalizedChannelId);
      if (before === normalizedChannelName) continue;

      teamMap.set(normalizedChannelId, normalizedChannelName);
      this.addChannelTeam(normalizedChannelId, normalizedTeamId);
      changedCounts.set(normalizedTeamId, (changedCounts.get(normalizedTeamId) ?? 0) + 1);
    }

    const updates: TeamChange[] = [];
    for (const [teamId, changed] of changedCounts.entries()) {
      const teamMap = this.channelNamesByTeam.get(teamId);
      if (!teamMap) continue;
      await this.persistChannelCache(teamId, teamMap);
      updates.push({ teamId, changed, total: teamMap.size });
    }
    return updates;
  }

  async updateUsers(
    users: Array<{ teamId: string; userId: string; user: SlackUserProfile }>
  ): Promise<TeamChange[]> {
    const changedCounts = new Map<string, number>();

    for (const user of users) {
      const teamId = user.teamId.trim();
      const userId = user.userId.trim();
      const userProfile = this.normalizeUserProfile(user.user);
      if (!teamId || !userId || !userProfile) continue;

      const profileMap = this.ensureUserProfileTeamMap(teamId);
      const before = profileMap.get(userId);
      if (before && this.isSameUserProfile(before, userProfile)) continue;
      profileMap.set(userId, userProfile);

      const userName = this.pickUserNameFromProfile(userProfile);
      if (userName) {
        this.ensureUserNameTeamMap(teamId).set(userId, userName);
      }
      changedCounts.set(teamId, (changedCounts.get(teamId) ?? 0) + 1);
    }

    const updates: TeamChange[] = [];
    for (const [teamId, changed] of changedCounts.entries()) {
      const profileMap = this.userProfilesByTeam.get(teamId);
      if (!profileMap) continue;
      await this.persistUserCache(teamId, profileMap);
      updates.push({ teamId, changed, total: profileMap.size });
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
        const parsed = JSON.parse(raw) as { users?: Record<string, unknown> };
        const users = parsed.users ?? {};
        for (const [userId, userValue] of Object.entries(users)) {
          const userProfile = this.parseUserProfile(userValue);
          if (!userProfile) continue;
          this.ensureUserProfileTeamMap(teamId).set(userId, userProfile);
          const userName = this.pickUserNameFromProfile(userProfile);
          if (userName) {
            this.ensureUserNameTeamMap(teamId).set(userId, userName);
          }
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

  private async persistUserCache(
    teamId: string,
    users: Map<string, SlackUserProfile>
  ): Promise<void> {
    const filePath = this.userCachePath;
    if (!filePath) return;

    const teamDir = this.toTeamCacheDir(filePath);
    const target = join(teamDir, `${teamId}.json`);
    const payload = {
      schema: "adjutant.slack.user-cache.v2",
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

  private ensureUserNameTeamMap(teamId: string): Map<string, string> {
    let teamMap = this.userNamesByTeam.get(teamId);
    if (!teamMap) {
      teamMap = new Map<string, string>();
      this.userNamesByTeam.set(teamId, teamMap);
    }
    return teamMap;
  }

  private ensureUserProfileTeamMap(teamId: string): Map<string, SlackUserProfile> {
    let teamMap = this.userProfilesByTeam.get(teamId);
    if (!teamMap) {
      teamMap = new Map<string, SlackUserProfile>();
      this.userProfilesByTeam.set(teamId, teamMap);
    }
    return teamMap;
  }

  private parseUserProfile(value: unknown): SlackUserProfile | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return this.normalizeUserProfile(value as SlackUserProfile);
  }

  private normalizeUserProfile(value: SlackUserProfile): SlackUserProfile | undefined {
    const normalized: SlackUserProfile = {};
    const realName = this.normalizeString(value.real_name);
    if (realName) normalized.real_name = realName;

    const sourceProfile = value.profile;
    if (sourceProfile && typeof sourceProfile === "object" && !Array.isArray(sourceProfile)) {
      const profile: NonNullable<SlackUserProfile["profile"]> = {};
      const displayName = this.normalizeString(sourceProfile.display_name);
      const email = this.normalizeString(sourceProfile.email);
      const firstName = this.normalizeString(sourceProfile.first_name);
      const lastName = this.normalizeString(sourceProfile.last_name);
      const imageOriginal = this.normalizeString(sourceProfile.image_original);
      if (displayName) profile.display_name = displayName;
      if (email) profile.email = email;
      if (firstName) profile.first_name = firstName;
      if (lastName) profile.last_name = lastName;
      if (imageOriginal) profile.image_original = imageOriginal;
      if (Object.keys(profile).length > 0) {
        normalized.profile = profile;
      }
    }

    if (!normalized.real_name && !normalized.profile) return undefined;
    return normalized;
  }

  private pickUserNameFromProfile(profile: SlackUserProfile): string | undefined {
    const displayName = this.normalizeString(profile.profile?.display_name);
    if (displayName) return displayName;
    const realName = this.normalizeString(profile.real_name);
    if (realName) return realName;
    const firstName = this.normalizeString(profile.profile?.first_name);
    const lastName = this.normalizeString(profile.profile?.last_name);
    if (firstName && lastName) return `${firstName} ${lastName}`;
    return firstName || lastName;
  }

  private isSameUserProfile(a: SlackUserProfile, b: SlackUserProfile): boolean {
    return (
      this.normalizeString(a.real_name) === this.normalizeString(b.real_name) &&
      this.normalizeString(a.profile?.display_name) ===
        this.normalizeString(b.profile?.display_name) &&
      this.normalizeString(a.profile?.email) === this.normalizeString(b.profile?.email) &&
      this.normalizeString(a.profile?.first_name) === this.normalizeString(b.profile?.first_name) &&
      this.normalizeString(a.profile?.last_name) === this.normalizeString(b.profile?.last_name) &&
      this.normalizeString(a.profile?.image_original) ===
        this.normalizeString(b.profile?.image_original)
    );
  }

  private normalizeString(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
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
