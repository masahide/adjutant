export type UrlInfo = {
  pathSegments?: string[];
};

export type ChannelProjection = {
  teamId: string;
  channelId: string;
  channelName: string;
};

export type UserProjection = {
  teamId: string;
  userId: string;
  userName: string;
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
      const userName = this.pickUserName(user);
      if (!userId || !teamId || !userName) continue;

      users.push({ teamId, userId, userName });
    }

    return users;
  }

  private pickUserName(user: Record<string, unknown>): string | undefined {
    const profile = this.asRecord(user.profile);
    const accountName = this.asString(user.name);
    const displayName = this.asString(profile?.display_name);
    const realName = this.asString(user.real_name) ?? this.asString(profile?.real_name);
    return accountName || displayName || realName;
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
