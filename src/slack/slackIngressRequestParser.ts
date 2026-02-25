import type { FetchPausedEvent } from "./slackIngressHandlers.js";
import type { SlackDebug } from "./slackDebug.js";

const JSONISH_PAYLOAD_KEYS = new Set(["blocks", "item", "attachments", "metadata", "message"]);

export type SlackUrlInfo = {
  protocol?: string;
  origin?: string;
  host?: string;
  hostname?: string;
  port?: string;
  pathname?: string;
  pathSegments?: string[];
  search?: string;
  query?: Record<string, string | string[]>;
  hash?: string;
};

export type ParsedSlackRequest = {
  url: URL;
  payload: Record<string, unknown>;
  contentType: string;
};

export type SlackIngressRequestParserDeps = {
  slackApiRe: RegExp;
  slackDebug: SlackDebug;
  pushDebugEvent: (kind: "raw_fetch", payload: unknown) => void;
  truncateForDebug: (value: string, max: number) => string;
};

type ParseSlackRequestBodyOptions = {
  onError?: (message: string) => void;
};

export function parseSlackRequestBody(
  body: string,
  contentType: string,
  options?: ParseSlackRequestBodyOptions
): Record<string, unknown> | null {
  if (!body) return {};
  if (/application\/json|text\/json/i.test(contentType) || body.trim().startsWith("{")) {
    try {
      return JSON.parse(body);
    } catch {
      options?.onError?.("failed to parse JSON body");
      return null;
    }
  }

  if (/application\/x-www-form-urlencoded/i.test(contentType)) {
    try {
      const params = new URLSearchParams(body);
      const result: Record<string, unknown> = {};
      for (const [key, value] of params.entries()) {
        result[key] = value;
        if (key === "payload") {
          try {
            const parsed = JSON.parse(value);
            Object.assign(result, parsed);
          } catch {
            options?.onError?.("failed to parse nested payload JSON");
          }
        }
      }
      return result;
    } catch {
      options?.onError?.("failed to parse form body");
      return null;
    }
  }

  if (/multipart\/form-data/i.test(contentType)) {
    const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
    if (!boundaryMatch) {
      options?.onError?.("missing multipart boundary");
      return null;
    }

    const boundary = `--${boundaryMatch[1].replace(/^["']|["']$/g, "")}`;
    const segments = body.split(boundary);
    const result: Record<string, unknown> = {};

    for (const segment of segments) {
      const trimmed = segment.trim();
      if (!trimmed || trimmed === "--") continue;

      const [headerSection, ...valueSections] = trimmed.split("\r\n\r\n");
      if (!headerSection || valueSections.length === 0) continue;

      const headers = headerSection.split("\r\n");
      const disposition = headers.find((line) => /content-disposition/i.test(line)) ?? "";
      const nameMatch = disposition.match(/name="([^"]+)"/i);
      if (!nameMatch) continue;

      let value = valueSections.join("\r\n\r\n");
      value = value.replace(/\r\n--$/, "");
      const normalizedValue = value.trim();

      result[nameMatch[1]] = normalizedValue;
      if (nameMatch[1] === "payload") {
        try {
          const parsed = JSON.parse(normalizedValue);
          Object.assign(result, parsed);
        } catch {
          options?.onError?.("failed to parse multipart payload JSON");
        }
      }
    }

    return result;
  }

  if (/^text\//i.test(contentType)) {
    const trimmed = body.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        options?.onError?.("failed to parse text/* JSON body");
        return null;
      }
    }
  }

  return null;
}

export function normalizeSlackParsedPayload(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...payload };
  for (const [key, value] of Object.entries(normalized)) {
    if (!JSONISH_PAYLOAD_KEYS.has(key)) continue;
    normalized[key] = parseJsonIfString(value);
  }
  return normalized;
}

export class SlackIngressRequestParser {
  constructor(private readonly deps: SlackIngressRequestParserDeps) {}

  parse(event: FetchPausedEvent): ParsedSlackRequest | null {
    if (event.request.method !== "POST") return null;
    if (!this.deps.slackApiRe.test(event.request.url)) return null;

    const body = event.request.postData ?? "";
    const contentType = this.normalizeHeader(event.request.headers, "content-type");
    this.deps.pushDebugEvent("raw_fetch", {
      method: event.request.method,
      url: event.request.url,
      urlInfo: this.parseUrlInfo(event.request.url),
      contentType,
      body: this.deps.truncateForDebug(body, 4000),
    });

    const url = new URL(event.request.url);
    const parsedPayload = parseSlackRequestBody(body, contentType, {
      onError: (message) => this.deps.slackDebug.debug(message),
    });
    const payload = parsedPayload ? normalizeSlackParsedPayload(parsedPayload) : null;
    if (!payload) {
      this.deps.slackDebug.debug("parseBody returned null", {
        url: event.request.url,
        contentType,
      });
      return null;
    }

    this.deps.slackDebug.verbose("parsed payload", this.deps.slackDebug.redactPayload(payload));
    return { url, payload, contentType };
  }

  normalizeHeader(headers: Record<string, string> | undefined, key: string): string {
    if (!headers) return "";
    const direct = headers[key];
    if (direct) return direct;
    const lower = headers[key.toLowerCase()];
    if (lower) return lower;
    const upper = headers[key.toUpperCase()];
    if (upper) return upper;
    const target = key.toLowerCase();
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === target) return value;
    }
    return "";
  }

  parseUrlInfo(url: string): SlackUrlInfo | null {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      const query: Record<string, string | string[]> = {};
      for (const [key, value] of parsed.searchParams.entries()) {
        if (key in query) {
          const current = query[key];
          query[key] = Array.isArray(current) ? [...current, value] : [current, value];
        } else {
          query[key] = value;
        }
      }
      return {
        protocol: parsed.protocol,
        origin: parsed.origin,
        host: parsed.host,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        pathname: parsed.pathname,
        pathSegments: parsed.pathname.split("/").filter((segment) => segment.length > 0),
        search: parsed.search || undefined,
        query: Object.keys(query).length > 0 ? query : undefined,
        hash: parsed.hash || undefined,
      };
    } catch {
      return null;
    }
  }
}

function parseJsonIfString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const prefix = trimmed[0];
  if (prefix !== "{" && prefix !== "[") return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}
