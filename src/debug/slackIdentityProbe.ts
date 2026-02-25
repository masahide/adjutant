import {
  normalizeSlackParsedPayload,
  parseSlackRequestBody,
} from "../slack/slackIngressRequestParser.js";
import { SlackNameCacheRepository } from "../slack/nameCacheRepository.js";

type SlackApiNameLookup = {
  attempted: boolean;
  endpoint: "users.info" | "conversations.info";
  ok: boolean;
  id?: string;
  name?: string;
  status?: number;
  error?: string;
};

export type SlackApiCallTrace = {
  endpoint: string;
  request: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    params: Record<string, string>;
  };
  response: {
    status: number;
    ok: boolean;
    error?: string;
    body?: Record<string, unknown> | null;
  };
};

export type SlackRequestWillBeSentPayload = {
  requestId?: string;
  method?: string;
  url?: string;
  contentType?: string;
  body?: unknown;
};

export type SlackIdentityProbeResult = {
  ok: boolean;
  requestId?: string;
  url?: string;
  contentType?: string;
  tokenMasked?: string;
  userId?: string;
  channelId?: string;
  usersInfo: SlackApiNameLookup;
  conversationsInfo: SlackApiNameLookup;
  apiCalls: SlackApiCallTrace[];
  warnings: string[];
};

type SlackIdentityProbeDeps = {
  fetchImpl?: typeof fetch;
  channelCachePath?: string;
  userCachePath?: string;
  cacheRepository?: SlackNameCacheRepository;
};

type LookupMode = "conversations" | "users" | "both" | "none";

export class SlackIdentityProbe {
  private readonly fetchImpl: typeof fetch;
  private readonly cacheRepository: SlackNameCacheRepository | null;
  private cacheLoaded = false;
  private cacheLoadPromise: Promise<void> | null = null;

  constructor(deps?: SlackIdentityProbeDeps) {
    this.fetchImpl = deps?.fetchImpl ?? fetch;
    if (deps?.cacheRepository) {
      this.cacheRepository = deps.cacheRepository;
      return;
    }
    const hasCachePath = Boolean(deps?.channelCachePath || deps?.userCachePath);
    this.cacheRepository = hasCachePath
      ? new SlackNameCacheRepository({
          channelCachePath: deps?.channelCachePath,
          userCachePath: deps?.userCachePath,
        })
      : null;
  }

  async resolve(input: SlackRequestWillBeSentPayload): Promise<SlackIdentityProbeResult> {
    const warnings: string[] = [];
    const result: SlackIdentityProbeResult = {
      ok: false,
      requestId: this.nonEmpty(input.requestId),
      url: this.nonEmpty(input.url),
      contentType: this.nonEmpty(input.contentType),
      usersInfo: { attempted: false, endpoint: "users.info", ok: false },
      conversationsInfo: { attempted: false, endpoint: "conversations.info", ok: false },
      apiCalls: [],
      warnings,
    };

    const parsedPayload = this.parsePayload(input.body, input.contentType ?? "", warnings);
    if (!parsedPayload) {
      warnings.push("request body を解析できませんでした");
      return result;
    }

    const token = this.extractToken(parsedPayload);
    if (!token) {
      warnings.push("token を body から抽出できませんでした");
      return result;
    }
    result.tokenMasked = this.maskSecret(token);

    const payloadUserId = this.extractUserId(parsedPayload);
    const payloadChannelId = this.extractChannelId(parsedPayload);
    let userId: string | undefined;
    let channelId: string | undefined;

    const origin = this.extractOrigin(input.url, warnings);
    if (!origin) {
      warnings.push("API呼び出し先 origin を特定できませんでした");
      return result;
    }

    const lookupMode = this.decideLookupMode(input.url);
    if (lookupMode === "none") {
      warnings.push("name lookup 対象外のエンドポイントです");
      return result;
    }

    const teamIdHint = this.extractTeamIdHint(input.url);
    if (lookupMode === "users" || lookupMode === "both") {
      userId = await this.pickFallbackUserId(teamIdHint);
      if (userId) {
        warnings.push(`users.info 用の user id をキャッシュ参照しました: ${userId}`);
        if (payloadUserId && payloadUserId !== userId) {
          warnings.push(
            `payload の user id(${payloadUserId}) は使用せず、キャッシュ値を使用しました`
          );
        }
      } else {
        warnings.push("users.info 用の user id がキャッシュに見つかりませんでした");
      }
    }
    if (lookupMode === "conversations" || lookupMode === "both") {
      channelId = await this.pickFallbackChannelId(teamIdHint);
      if (channelId) {
        warnings.push(`conversations.info 用の channel id をキャッシュ参照しました: ${channelId}`);
        if (payloadChannelId && payloadChannelId !== channelId) {
          warnings.push(
            `payload の channel id(${payloadChannelId}) は使用せず、キャッシュ値を使用しました`
          );
        }
      } else {
        warnings.push("conversations.info 用の channel id がキャッシュに見つかりませんでした");
      }
    }

    if (userId) result.userId = userId;
    if (channelId) result.channelId = channelId;

    if ((lookupMode === "users" || lookupMode === "both") && userId) {
      if (this.isCacheUsersInfoEndpoint(input.url)) {
        result.usersInfo = await this.lookupUserNameViaCacheUsersInfo({
          requestUrl: input.url ?? "",
          token,
          userId,
          contentType: input.contentType,
          parsedPayload,
          apiCalls: result.apiCalls,
        });
      } else {
        result.usersInfo = await this.lookupUserName(origin, token, userId, result.apiCalls);
      }
    }

    if ((lookupMode === "conversations" || lookupMode === "both") && channelId) {
      result.conversationsInfo = await this.lookupChannelName(
        origin,
        token,
        channelId,
        result.apiCalls
      );
    }

    result.ok = result.usersInfo.ok || result.conversationsInfo.ok;
    return result;
  }

  private parsePayload(
    body: unknown,
    contentType: string,
    warnings: string[]
  ): Record<string, unknown> | null {
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return normalizeSlackParsedPayload(body as Record<string, unknown>);
    }
    if (typeof body !== "string") {
      warnings.push("request body が string/object ではありません");
      return null;
    }

    const parsed = parseSlackRequestBody(body, contentType, {
      onError: (message) => warnings.push(message),
    });
    if (!parsed) return null;
    return normalizeSlackParsedPayload(parsed);
  }

  private extractOrigin(urlValue: string | undefined, warnings: string[]): string | null {
    if (!urlValue) return null;
    try {
      const parsed = new URL(urlValue);
      return parsed.origin;
    } catch {
      warnings.push("URL の形式が不正です");
      return null;
    }
  }

  private decideLookupMode(urlValue: string | undefined): LookupMode {
    if (!urlValue) return "both";
    try {
      const parsed = new URL(urlValue);
      const pathname = parsed.pathname.toLowerCase();
      const segments = pathname.split("/").filter(Boolean);

      if (pathname.startsWith("/cache/") && segments.length >= 4) {
        if (segments[2] === "users" && segments[3] === "info") return "users";
        if (segments[2] === "channels" && (segments[3] === "info" || segments[3] === "search")) {
          return "conversations";
        }
      }

      if (!pathname.startsWith("/api/")) return "none";
      if (pathname.includes("/api/conversations.")) return "conversations";
      if (pathname.includes("/api/users.")) return "users";
      return "both";
    } catch {
      return "both";
    }
  }

  private extractTeamIdHint(urlValue: string | undefined): string | undefined {
    if (!urlValue) return undefined;
    try {
      const parsed = new URL(urlValue);
      const pathnameSegments = parsed.pathname.split("/").filter(Boolean);
      if (pathnameSegments[0] === "cache" && pathnameSegments[1]) {
        return this.normalizeTeamIdHint(pathnameSegments[1]);
      }
      const slackRoute = parsed.searchParams.get("slack_route");
      if (slackRoute) {
        const [first] = slackRoute.split(":");
        return this.normalizeTeamIdHint(first);
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private normalizeTeamIdHint(value: string | undefined): string | undefined {
    const normalized = this.nonEmpty(value)?.toUpperCase();
    if (!normalized) return undefined;
    return /^[A-Z0-9]{5,}$/.test(normalized) ? normalized : undefined;
  }

  private isCacheUsersInfoEndpoint(urlValue: string | undefined): boolean {
    if (!urlValue) return false;
    try {
      const parsed = new URL(urlValue);
      const segments = parsed.pathname.toLowerCase().split("/").filter(Boolean);
      return (
        segments.length >= 4 &&
        segments[0] === "cache" &&
        segments[2] === "users" &&
        segments[3] === "info"
      );
    } catch {
      return false;
    }
  }

  private async lookupUserName(
    origin: string,
    token: string,
    userId: string,
    apiCalls: SlackApiCallTrace[]
  ): Promise<SlackApiNameLookup> {
    const response = await this.callSlackApi(
      new URL("/api/users.info", origin).toString(),
      {
        token,
        user: userId,
      },
      apiCalls
    );
    if (!response.ok || !response.body) {
      return {
        attempted: true,
        endpoint: "users.info",
        ok: false,
        id: userId,
        status: response.status,
        error: response.error ?? "users.info failed",
      };
    }
    const user = this.asRecord(response.body.user);
    const profile = this.asRecord(user?.profile);
    const name =
      this.nonEmpty(this.asString(profile?.display_name)) ??
      this.nonEmpty(this.asString(profile?.real_name)) ??
      this.nonEmpty(this.asString(user?.name));
    return {
      attempted: true,
      endpoint: "users.info",
      ok: true,
      id: userId,
      name: name ?? "(unknown)",
      status: response.status,
    };
  }

  private async lookupUserNameViaCacheUsersInfo(params: {
    requestUrl: string;
    token: string;
    userId: string;
    contentType?: string;
    parsedPayload: Record<string, unknown>;
    apiCalls: SlackApiCallTrace[];
  }): Promise<SlackApiNameLookup> {
    const requestBody = this.buildCacheUsersInfoBody(
      params.parsedPayload,
      params.token,
      params.userId
    );
    const contentType = this.nonEmpty(params.contentType) ?? "text/plain;charset=UTF-8";
    const redactedBody = this.redactUnknown(requestBody);
    try {
      const response = await this.fetchImpl(params.requestUrl, {
        method: "POST",
        headers: { "content-type": contentType },
        body: JSON.stringify(requestBody),
      });
      const text = await response.text();
      const parsed = this.tryParseJsonObject(text);
      if (!response.ok) {
        params.apiCalls.push({
          endpoint: params.requestUrl,
          request: {
            method: "POST",
            headers: { "content-type": contentType },
            body: redactedBody,
            params: { mode: "cache-users-info", user: params.userId },
          },
          response: {
            status: response.status,
            ok: false,
            error: `http_${response.status}`,
            body: parsed,
          },
        });
        return {
          attempted: true,
          endpoint: "users.info",
          ok: false,
          id: params.userId,
          status: response.status,
          error: `http_${response.status}`,
        };
      }
      if (!parsed) {
        params.apiCalls.push({
          endpoint: params.requestUrl,
          request: {
            method: "POST",
            headers: { "content-type": contentType },
            body: redactedBody,
            params: { mode: "cache-users-info", user: params.userId },
          },
          response: {
            status: response.status,
            ok: false,
            error: "invalid_json",
            body: null,
          },
        });
        return {
          attempted: true,
          endpoint: "users.info",
          ok: false,
          id: params.userId,
          status: response.status,
          error: "invalid_json",
        };
      }
      if (parsed.ok !== true) {
        const errorMessage = this.asString(parsed.error) ?? "slack_api_error";
        params.apiCalls.push({
          endpoint: params.requestUrl,
          request: {
            method: "POST",
            headers: { "content-type": contentType },
            body: redactedBody,
            params: { mode: "cache-users-info", user: params.userId },
          },
          response: {
            status: response.status,
            ok: false,
            error: errorMessage,
            body: parsed,
          },
        });
        return {
          attempted: true,
          endpoint: "users.info",
          ok: false,
          id: params.userId,
          status: response.status,
          error: errorMessage,
        };
      }

      params.apiCalls.push({
        endpoint: params.requestUrl,
        request: {
          method: "POST",
          headers: { "content-type": contentType },
          body: redactedBody,
          params: { mode: "cache-users-info", user: params.userId },
        },
        response: {
          status: response.status,
          ok: true,
          body: parsed,
        },
      });
      const userRecord = this.extractUserRecordFromUsersInfo(parsed, params.userId);
      const profile = this.asRecord(userRecord?.profile);
      const name =
        this.nonEmpty(this.asString(profile?.display_name)) ??
        this.nonEmpty(this.asString(profile?.real_name)) ??
        this.nonEmpty(this.asString(userRecord?.name));
      return {
        attempted: true,
        endpoint: "users.info",
        ok: true,
        id: params.userId,
        name: name ?? "(unknown)",
        status: response.status,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "network_error";
      params.apiCalls.push({
        endpoint: params.requestUrl,
        request: {
          method: "POST",
          headers: { "content-type": contentType },
          body: redactedBody,
          params: { mode: "cache-users-info", user: params.userId },
        },
        response: {
          status: 0,
          ok: false,
          error: errorMessage,
        },
      });
      return {
        attempted: true,
        endpoint: "users.info",
        ok: false,
        id: params.userId,
        status: 0,
        error: errorMessage,
      };
    }
  }

  private buildCacheUsersInfoBody(
    parsedPayload: Record<string, unknown>,
    token: string,
    userId: string
  ): Record<string, unknown> {
    const base: Record<string, unknown> = { ...parsedPayload };
    base.token = token;
    const updatedIdsValue = this.asRecord(base.updated_ids) ?? {};
    const updatedIds: Record<string, unknown> = { ...updatedIdsValue };
    updatedIds[userId] = updatedIds[userId] ?? 0;
    base.updated_ids = updatedIds;
    if (!("check_interaction" in base)) base.check_interaction = true;
    if (!("include_profile_only_users" in base)) base.include_profile_only_users = true;
    return base;
  }

  private extractUserRecordFromUsersInfo(
    payload: Record<string, unknown>,
    userId: string
  ): Record<string, unknown> | null {
    const usersMap = this.asRecord(payload.users);
    const direct = this.asRecord(usersMap?.[userId]);
    if (direct) return direct;

    const results = payload.results;
    if (Array.isArray(results)) {
      const matched = results.find((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return false;
        const candidate = this.asRecord(item);
        return this.asString(candidate?.id) === userId;
      });
      if (matched && typeof matched === "object" && !Array.isArray(matched)) {
        return matched as Record<string, unknown>;
      }
    }

    const user = this.asRecord(payload.user);
    if (user && this.asString(user.id) === userId) return user;
    return null;
  }

  private async lookupChannelName(
    origin: string,
    token: string,
    channelId: string,
    apiCalls: SlackApiCallTrace[]
  ): Promise<SlackApiNameLookup> {
    const response = await this.callSlackApi(
      new URL("/api/conversations.info", origin).toString(),
      {
        token,
        channel: channelId,
      },
      apiCalls
    );
    if (!response.ok || !response.body) {
      return {
        attempted: true,
        endpoint: "conversations.info",
        ok: false,
        id: channelId,
        status: response.status,
        error: response.error ?? "conversations.info failed",
      };
    }
    const channel = this.asRecord(response.body.channel);
    const name =
      this.nonEmpty(this.asString(channel?.name)) ??
      this.nonEmpty(this.asString(channel?.name_normalized));
    return {
      attempted: true,
      endpoint: "conversations.info",
      ok: true,
      id: channelId,
      name: name ?? "(unknown)",
      status: response.status,
    };
  }

  private async callSlackApi(
    endpoint: string,
    params: Record<string, string>,
    apiCalls: SlackApiCallTrace[]
  ): Promise<{
    ok: boolean;
    status: number;
    body: Record<string, unknown> | null;
    error?: string;
  }> {
    const requestParams = this.redactRequestParams(params);
    const body = new URLSearchParams(params).toString();
    try {
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        body,
      });
      const text = await response.text();
      const parsed = this.tryParseJsonObject(text);
      if (!response.ok) {
        apiCalls.push({
          endpoint,
          request: { params: requestParams },
          response: {
            status: response.status,
            ok: false,
            error: `http_${response.status}`,
            body: parsed,
          },
        });
        return {
          ok: false,
          status: response.status,
          body: parsed,
          error: `http_${response.status}`,
        };
      }
      if (!parsed) {
        apiCalls.push({
          endpoint,
          request: { params: requestParams },
          response: {
            status: response.status,
            ok: false,
            error: "invalid_json",
            body: null,
          },
        });
        return {
          ok: false,
          status: response.status,
          body: null,
          error: "invalid_json",
        };
      }
      if (parsed.ok !== true) {
        const errorMessage = this.asString(parsed.error) ?? "slack_api_error";
        apiCalls.push({
          endpoint,
          request: { params: requestParams },
          response: {
            status: response.status,
            ok: false,
            error: errorMessage,
            body: parsed,
          },
        });
        return {
          ok: false,
          status: response.status,
          body: parsed,
          error: errorMessage,
        };
      }
      apiCalls.push({
        endpoint,
        request: { params: requestParams },
        response: {
          status: response.status,
          ok: true,
          body: parsed,
        },
      });
      return { ok: true, status: response.status, body: parsed };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "network_error";
      apiCalls.push({
        endpoint,
        request: { params: requestParams },
        response: {
          status: 0,
          ok: false,
          error: errorMessage,
        },
      });
      return {
        ok: false,
        status: 0,
        body: null,
        error: errorMessage,
      };
    }
  }

  private redactRequestParams(params: Record<string, string>): Record<string, string> {
    const redacted: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      if (/token|cookie/i.test(key)) {
        redacted[key] = this.maskSecret(value);
        continue;
      }
      redacted[key] = value;
    }
    return redacted;
  }

  private redactUnknown(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.redactUnknown(item));
    }
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (typeof entry === "string" && /(token|cookie)/i.test(key)) {
        redacted[key] = this.maskSecret(entry);
        continue;
      }
      redacted[key] = this.redactUnknown(entry);
    }
    return redacted;
  }

  private extractToken(payload: Record<string, unknown>): string | undefined {
    return this.findFirstByKeys(payload, ["token", "api_token", "authed_user_token"]);
  }

  private extractUserId(payload: Record<string, unknown>): string | undefined {
    const candidate = this.findFirstByKeys(payload, ["user", "user_id", "userId", "member"]);
    if (!candidate) return undefined;
    return /^U[A-Z0-9]+$/i.test(candidate) ? candidate : undefined;
  }

  private extractChannelId(payload: Record<string, unknown>): string | undefined {
    const candidate = this.findFirstByKeys(payload, [
      "channel",
      "channel_id",
      "channelId",
      "conversation",
      "conversation_id",
    ]);
    if (!candidate) return undefined;
    return /^[CDG][A-Z0-9]+$/i.test(candidate) ? candidate : undefined;
  }

  private async pickFallbackUserId(teamIdHint: string | undefined): Promise<string | undefined> {
    await this.ensureCacheLoaded();
    return this.cacheRepository?.pickAnyUserId(teamIdHint);
  }

  private async pickFallbackChannelId(teamIdHint: string | undefined): Promise<string | undefined> {
    await this.ensureCacheLoaded();
    return this.cacheRepository?.pickAnyChannelId(teamIdHint);
  }

  private async ensureCacheLoaded(): Promise<void> {
    if (!this.cacheRepository || this.cacheLoaded) return;
    if (!this.cacheLoadPromise) {
      this.cacheLoadPromise = this.cacheRepository
        .load()
        .catch(() => undefined)
        .then(() => {
          this.cacheLoaded = true;
        });
    }
    await this.cacheLoadPromise;
  }

  private findFirstByKeys(payload: Record<string, unknown>, keys: string[]): string | undefined {
    const wanted = new Set(keys.map((key) => key.toLowerCase()));
    const queue: unknown[] = [payload];
    const seen = new Set<unknown>();
    let visited = 0;

    while (queue.length > 0 && visited < 2000) {
      visited += 1;
      const current = queue.shift();
      if (!current || typeof current !== "object") continue;
      if (seen.has(current)) continue;
      seen.add(current);

      if (Array.isArray(current)) {
        queue.push(...current);
        continue;
      }

      const record = current as Record<string, unknown>;
      for (const [key, value] of Object.entries(record)) {
        if (typeof value === "string" && wanted.has(key.toLowerCase())) {
          const normalized = this.nonEmpty(value);
          if (normalized) return normalized;
        }
        if (value && typeof value === "object") {
          queue.push(value);
        }
      }
    }

    return undefined;
  }

  private tryParseJsonObject(text: string): Record<string, unknown> | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  private asString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
  }

  private nonEmpty(value: string | undefined | null): string | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private maskSecret(value: string): string {
    if (value.length <= 8) return "********";
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }
}
