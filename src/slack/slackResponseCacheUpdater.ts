import type { SlackNameCacheRepository } from "./nameCacheRepository.js";
import type { ResponseBodyReader } from "./responseBodyReader.js";
import type {
  ChannelProjection,
  SlackResponseProjector,
  UserProjection,
  UrlInfo,
} from "./responseProjector.js";
import type { RequestWillBeSentEvent, ResponseReceivedEvent } from "./slackIngressHandlers.js";
import type { SlackUrlInfo } from "./slackIngressRequestParser.js";

export type SlackResponseCacheUpdaterDeps = {
  slackApiRe: RegExp;
  debugFetchHookEnabled: boolean;
  pushDebugEvent: (kind: "raw_fetch", payload: unknown) => void;
  truncateForDebug: (value: string, max: number) => string;
  responseBodyReader: ResponseBodyReader;
  responseProjector: SlackResponseProjector;
  nameCacheRepository: SlackNameCacheRepository;
  cacheMessage: (
    channel: string,
    ts: string,
    value: { text?: string | null; user?: string | null; teamId?: string | null }
  ) => void;
  parseUrlInfo: (url: string) => SlackUrlInfo | null;
  normalizeHeader: (headers: Record<string, string> | undefined, key: string) => string;
  toTextFromBlocks: (blocks: unknown) => string;
  logCacheUpdate: (
    kind: "channel" | "user",
    teamId: string,
    changed: number,
    total: number
  ) => void;
};

export class SlackResponseCacheUpdater {
  constructor(private readonly deps: SlackResponseCacheUpdaterDeps) {}

  async handleResponseReceived(event: ResponseReceivedEvent): Promise<void> {
    if (this.deps.debugFetchHookEnabled) {
      await this.pushResponseDebugEvent(event);
    }
    await this.refreshChannelNamesFromResponses(event);
    await this.refreshUserNameFromUsersList(event);
    if (!this.deps.slackApiRe.test(event.response.url)) return;

    try {
      const json = await this.deps.responseBodyReader.readJson(event.requestId);
      if (!json.data || json.invalidJson) return;
      const data = this.asRecord(json.data);
      if (!data) return;
      const message = this.asRecord(data.message ?? data.item);
      const channel = this.asString(message?.channel);
      const ts = this.asString(message?.ts);
      if (channel && ts) {
        const text = this.deps.toTextFromBlocks(message?.blocks);
        this.deps.cacheMessage(channel, ts, { text, user: this.asString(message?.user) });
      }
    } catch {
      // ignore errors
    }
  }

  async handleRequestWillBeSent(event: RequestWillBeSentEvent): Promise<void> {
    if (!this.deps.debugFetchHookEnabled) return;
    if (!event?.request?.url || !event?.request?.method) return;

    const resourceType = this.asString(event.type) ?? "";
    if (resourceType && resourceType !== "Fetch" && resourceType !== "XHR") return;

    const initiatorType = this.asString(event.initiator?.type);
    const body = event.request.postData ?? "";
    const contentType = this.deps.normalizeHeader(event.request.headers, "content-type");
    this.deps.pushDebugEvent("raw_fetch", {
      stage: "requestWillBeSent",
      requestId: event.requestId,
      resourceType: resourceType || undefined,
      initiatorType,
      method: event.request.method,
      url: event.request.url,
      urlInfo: this.deps.parseUrlInfo(event.request.url),
      contentType,
      body: this.deps.truncateForDebug(body, 4000),
    });
  }

  private async pushResponseDebugEvent(event: ResponseReceivedEvent): Promise<void> {
    const resourceType = this.asString(event.type) ?? "";
    if (resourceType && resourceType !== "Fetch" && resourceType !== "XHR") return;
    if (!event?.response?.url) return;

    const contentType =
      this.deps.normalizeHeader(event.response.headers, "content-type") ||
      event.response.mimeType ||
      "";

    const bodyResult = await this.deps.responseBodyReader.readText(event.requestId);
    const bodyText = bodyResult.text;
    const bodyUnavailable = bodyResult.unavailable ? "unavailable" : null;

    const preview = this.previewResponseBody(bodyText, contentType);
    this.deps.pushDebugEvent("raw_fetch", {
      stage: "responseReceived",
      requestId: event.requestId,
      resourceType: resourceType || undefined,
      url: event.response.url,
      urlInfo: this.deps.parseUrlInfo(event.response.url),
      status: event.response.status,
      statusText: event.response.statusText,
      contentType: contentType || undefined,
      body: preview.body,
      bodyType: preview.bodyType,
      bodyUnavailable,
    });
  }

  private async refreshChannelNamesFromResponses(event: ResponseReceivedEvent): Promise<void> {
    const urlInfo = this.toProjectorUrlInfo(this.deps.parseUrlInfo(event.response.url));
    if (!urlInfo) return;

    const segments = urlInfo.pathSegments ?? [];
    const looksLikeChannelsInfo =
      segments.length >= 4 &&
      segments[0] === "cache" &&
      segments[2] === "channels" &&
      segments[3] === "info";
    const looksLikeChannelsSearch =
      segments.length >= 4 &&
      segments[0] === "cache" &&
      segments[2] === "channels" &&
      segments[3] === "search";
    const looksLikeConversationsView = urlInfo.pathname === "/api/conversations.view";
    const looksLikeGenericInfo = urlInfo.pathname === "/api/conversations.genericInfo";
    const looksLikeSearchModulesChannels = urlInfo.pathname === "/api/search.modules.channels";
    const looksLikeClientUserBoot = urlInfo.pathname === "/api/client.userBoot";
    if (
      !looksLikeChannelsInfo &&
      !looksLikeChannelsSearch &&
      !looksLikeConversationsView &&
      !looksLikeGenericInfo &&
      !looksLikeSearchModulesChannels &&
      !looksLikeClientUserBoot
    ) {
      return;
    }

    try {
      const json = await this.deps.responseBodyReader.readJson(event.requestId);
      if (!json.data || json.invalidJson) return;

      let projectedChannels: ChannelProjection[] = [];
      if (looksLikeConversationsView) {
        const projected = this.deps.responseProjector.projectConversationsView(json.data);
        if (projected) {
          projectedChannels = [projected];
        }
      } else if (looksLikeChannelsInfo) {
        projectedChannels = this.deps.responseProjector.projectChannelsInfo(json.data, urlInfo);
      } else if (looksLikeChannelsSearch) {
        projectedChannels = this.deps.responseProjector.projectChannelsSearch(json.data, urlInfo);
      } else if (looksLikeGenericInfo) {
        projectedChannels = this.deps.responseProjector.projectConversationsGenericInfo(
          json.data,
          urlInfo
        );
      } else if (looksLikeSearchModulesChannels) {
        projectedChannels = this.deps.responseProjector.projectSearchModulesChannels(
          json.data,
          urlInfo
        );
      } else if (looksLikeClientUserBoot) {
        projectedChannels = this.deps.responseProjector.projectClientUserBoot(json.data);
      }
      if (projectedChannels.length === 0) return;

      const changes = await this.deps.nameCacheRepository.updateChannels(projectedChannels);
      for (const changed of changes) {
        this.deps.logCacheUpdate("channel", changed.teamId, changed.changed, changed.total);
      }
    } catch {
      // ignore channel metadata parse errors
    }
  }

  private async refreshUserNameFromUsersList(event: ResponseReceivedEvent): Promise<void> {
    const urlInfo = this.toProjectorUrlInfo(this.deps.parseUrlInfo(event.response.url));
    if (!urlInfo) return;
    const segments = urlInfo.pathSegments ?? [];
    const looksLikeUserList =
      (segments.length >= 4 &&
        segments[0] === "cache" &&
        segments[2] === "users" &&
        segments[3] === "list") ||
      urlInfo.pathname === "/api/users.list";
    if (!looksLikeUserList) return;

    try {
      const json = await this.deps.responseBodyReader.readJson(event.requestId);
      if (!json.data || json.invalidJson) return;
      const projectedUsers: UserProjection[] = this.deps.responseProjector.projectUsersList(
        json.data,
        urlInfo
      );
      const changes = await this.deps.nameCacheRepository.updateUsers(projectedUsers);
      for (const changed of changes) {
        this.deps.logCacheUpdate("user", changed.teamId, changed.changed, changed.total);
      }
    } catch {
      // ignore users/list parse errors
    }
  }

  private previewResponseBody(
    bodyText: string | null,
    contentType: string
  ): { body: unknown; bodyType: "json" | "text" | "empty" } {
    if (!bodyText) {
      return { body: undefined, bodyType: "empty" };
    }

    const trimmed = bodyText.trim();
    const likelyJson =
      contentType.toLowerCase().includes("application/json") ||
      trimmed.startsWith("{") ||
      trimmed.startsWith("[");
    if (likelyJson) {
      try {
        return { body: JSON.parse(trimmed), bodyType: "json" };
      } catch {
        // Fall back to text when JSON parse fails.
      }
    }

    return { body: this.deps.truncateForDebug(bodyText, 4000), bodyType: "text" };
  }

  private asString(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  }

  private toProjectorUrlInfo(urlInfo: SlackUrlInfo | null): UrlInfo | null {
    if (!urlInfo) {
      return null;
    }
    return {
      pathname: urlInfo.pathname,
      pathSegments: urlInfo.pathSegments,
      query: urlInfo.query,
    };
  }
}
