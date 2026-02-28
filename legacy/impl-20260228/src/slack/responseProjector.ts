export type UrlInfo = {
  pathname?: string;
  pathSegments?: string[];
  query?: Record<string, string | string[]>;
};

export type ChannelProjection = {
  teamId: string;
  channelId: string;
  channelName: string;
};

export type UserProjection = {
  teamId: string;
  userId: string;
  user: {
    real_name?: string;
    profile?: {
      display_name?: string;
      email?: string;
      first_name?: string;
      last_name?: string;
      image_original?: string;
    };
  };
};

export class SlackResponseProjector {
  projectConversationsView(payload: unknown): ChannelProjection | null {
    const parsed = this.asRecord(payload);
    if (!parsed || parsed.ok !== true) return null;

    const channel = this.asRecord(parsed.channel);
    const history = this.asRecord(parsed.history);
    const historyMessages = Array.isArray(history?.messages) ? history.messages : [];
    const firstMessage = historyMessages.length > 0 ? this.asRecord(historyMessages[0]) : undefined;
    const users = Array.isArray(parsed.users) ? parsed.users : [];
    const firstUser = users.length > 0 ? this.asRecord(users[0]) : undefined;

    const channelId = this.asString(channel?.id);
    const channelName = this.asString(channel?.name);
    const teamId =
      this.asString(channel?.context_team_id) ??
      this.asString(firstMessage?.team) ??
      this.asString(firstUser?.team_id);

    if (!channelId || !channelName || !teamId) return null;
    return { teamId, channelId, channelName };
  }

  projectUsersList(payload: unknown, urlInfo: UrlInfo | null): UserProjection[] {
    const parsed = this.asRecord(payload);
    if (!parsed || parsed.ok !== true) return [];

    const segments = urlInfo?.pathSegments ?? [];
    const teamFromPath =
      segments.length >= 2 && segments[0] === "cache" && segments[1] ? segments[1] : undefined;

    const results = Array.isArray(parsed.results) ? parsed.results : [];
    const users: UserProjection[] = [];
    for (const item of results) {
      const user = this.asRecord(item);
      if (!user) continue;

      const userId = this.asString(user.id);
      const teamId =
        this.asString(user.team_id) ??
        this.asString(this.asRecord(user.profile)?.team) ??
        teamFromPath;
      const projectedUser = this.pickUser(user);
      if (!userId || !teamId || !projectedUser) continue;

      users.push({ teamId, userId, user: projectedUser });
    }

    return users;
  }

  projectChannelsInfo(payload: unknown, urlInfo: UrlInfo | null): ChannelProjection[] {
    const segments = urlInfo?.pathSegments ?? [];
    const teamFromPath =
      segments.length >= 4 &&
      segments[0] === "cache" &&
      segments[2] === "channels" &&
      segments[3] === "info"
        ? this.asString(segments[1])
        : undefined;
    return this.projectChannelsFromPayload(payload, teamFromPath);
  }

  projectChannelsSearch(payload: unknown, urlInfo: UrlInfo | null): ChannelProjection[] {
    const segments = urlInfo?.pathSegments ?? [];
    const teamFromPath =
      segments.length >= 4 &&
      segments[0] === "cache" &&
      segments[2] === "channels" &&
      segments[3] === "search"
        ? this.asString(segments[1])
        : undefined;
    return this.projectChannelsFromPayload(payload, teamFromPath);
  }

  projectConversationsGenericInfo(payload: unknown, urlInfo: UrlInfo | null): ChannelProjection[] {
    const teamFromRoute = this.extractTeamFromSlackRoute(urlInfo?.query);
    return this.projectChannelsFromPayload(payload, teamFromRoute);
  }

  projectSearchModulesChannels(payload: unknown, urlInfo: UrlInfo | null): ChannelProjection[] {
    const parsed = this.asRecord(payload);
    if (parsed && this.asString(parsed.module) && this.asString(parsed.module) !== "channels") {
      return [];
    }
    const teamFromRoute = this.extractTeamFromSlackRoute(urlInfo?.query);
    return this.projectChannelsFromPayload(payload, teamFromRoute);
  }

  projectClientUserBoot(payload: unknown): ChannelProjection[] {
    const parsed = this.asRecord(payload);
    if (!parsed || parsed.ok === false) return [];

    const defaultWorkspace = this.asRecord(parsed.default_workspace);
    const defaultTeamId =
      this.asString(defaultWorkspace?.id) ??
      this.asString(defaultWorkspace?.team_id) ??
      this.asString(parsed.team_id);

    const channels = Array.isArray(parsed.channels) ? parsed.channels : [];
    const projected: ChannelProjection[] = [];
    const seenByTeamAndChannel = new Set<string>();
    for (const item of channels) {
      const channel = this.asRecord(item);
      if (!channel) continue;
      const channelId = this.asChannelId(channel.id);
      const channelName = this.asString(channel.name) ?? this.asString(channel.name_normalized);
      const teamId =
        this.asString(channel.context_team_id) ??
        this.asString(channel.team_id) ??
        this.asString(channel.team) ??
        defaultTeamId;
      if (!teamId || !channelId || !channelName) continue;

      const key = `${teamId}\t${channelId}`;
      if (seenByTeamAndChannel.has(key)) continue;
      seenByTeamAndChannel.add(key);
      projected.push({ teamId, channelId, channelName });
    }

    return projected;
  }

  private pickUser(user: Record<string, unknown>): UserProjection["user"] | undefined {
    const profile = this.asRecord(user.profile);
    const projected: UserProjection["user"] = {};
    const realName = this.asString(user.real_name) ?? this.asString(profile?.real_name);
    if (realName) {
      projected.real_name = realName;
    }

    const projectedProfile: NonNullable<UserProjection["user"]["profile"]> = {};
    const displayName = this.asString(profile?.display_name);
    const email = this.asString(profile?.email);
    const firstName = this.asString(profile?.first_name);
    const lastName = this.asString(profile?.last_name);
    const imageOriginal = this.asString(profile?.image_original);
    if (displayName) projectedProfile.display_name = displayName;
    if (email) projectedProfile.email = email;
    if (firstName) projectedProfile.first_name = firstName;
    if (lastName) projectedProfile.last_name = lastName;
    if (imageOriginal) projectedProfile.image_original = imageOriginal;
    if (Object.keys(projectedProfile).length > 0) {
      projected.profile = projectedProfile;
    }

    if (!projected.real_name && !projected.profile) return undefined;
    return projected;
  }

  private projectChannelsFromPayload(
    payload: unknown,
    teamIdHint: string | undefined
  ): ChannelProjection[] {
    const parsed = this.asRecord(payload);
    if (!parsed || parsed.ok === false) return [];

    const queue: unknown[] = [parsed];
    const visited = new Set<unknown>();
    const projected: ChannelProjection[] = [];
    const seenByTeamAndChannel = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);

      if (Array.isArray(current)) {
        for (const item of current) queue.push(item);
        continue;
      }
      if (typeof current !== "object") continue;

      const record = current as Record<string, unknown>;
      const channelId = this.asChannelId(record.id);
      const channelName = this.asString(record.name) ?? this.asString(record.name_normalized);
      const teamId =
        this.asString(record.context_team_id) ??
        this.asString(record.team_id) ??
        this.asString(record.team) ??
        teamIdHint;
      if (teamId && channelId && channelName) {
        const key = `${teamId}\t${channelId}`;
        if (!seenByTeamAndChannel.has(key)) {
          seenByTeamAndChannel.add(key);
          projected.push({ teamId, channelId, channelName });
        }
      }

      for (const value of Object.values(record)) {
        queue.push(value);
      }
    }

    return projected;
  }

  private extractTeamFromSlackRoute(
    query: Record<string, string | string[]> | undefined
  ): string | undefined {
    if (!query) return undefined;
    const route = this.pickQueryValue(query.slack_route);
    if (!route) return undefined;
    return this.asString(route.split(":")[0]);
  }

  private pickQueryValue(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) {
      for (const item of value) {
        const candidate = this.asString(item);
        if (candidate) return candidate;
      }
      return undefined;
    }
    return this.asString(value);
  }

  private asChannelId(value: unknown): string | undefined {
    const id = this.asString(value);
    if (!id) return undefined;
    return /^[CDG][A-Z0-9]{8,}$/.test(id) ? id : undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  }

  private asString(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
}
