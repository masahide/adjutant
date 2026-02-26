const DEFAULT_TIMEOUT_MS = 120_000;
const SESSION_HEADER = "Mcp-Session-Id";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return "http://127.0.0.1:8080";
  }
  return trimmed.replace(/\/+$/, "");
}

export type SlackRpcClientErrorCode = "integration_unavailable" | "timeout" | "api_error";

export class SlackRpcClientError extends Error {
  readonly code: SlackRpcClientErrorCode;
  readonly status?: number;

  constructor(input: { code: SlackRpcClientErrorCode; message: string; status?: number }) {
    super(input.message);
    this.name = "SlackRpcClientError";
    this.code = input.code;
    this.status = input.status;
  }
}

export type SlackRpcToolCallResult = {
  isError: boolean;
  structuredContent?: unknown;
  text?: string;
  rawResult: unknown;
};

export type SlackRpcMcpClientOptions = {
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
};

export class SlackRpcMcpClient {
  private readonly endpoint: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly clientName: string;
  private readonly clientVersion: string;

  private sessionId: string | null = null;
  private requestId = 1;

  constructor(options: SlackRpcMcpClientOptions = {}) {
    this.endpoint = `${normalizeBaseUrl(options.baseUrl ?? "http://127.0.0.1:8080")}/mcp`;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs =
      typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.floor(options.timeoutMs))
        : DEFAULT_TIMEOUT_MS;
    this.clientName = asString(options.clientName) ?? "adjutant";
    this.clientVersion = asString(options.clientVersion) ?? "0.1.0";
  }

  async initializeIfNeeded(force = false): Promise<void> {
    if (!force && this.sessionId) {
      return;
    }

    const result = await this.sendJsonRpc("initialize", {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: this.clientName,
        version: this.clientVersion,
      },
    });

    if (!this.sessionId) {
      throw new SlackRpcClientError({
        code: "integration_unavailable",
        message: "mcp-session-id header is missing on initialize",
      });
    }

    if (!asRecord(result)) {
      throw new SlackRpcClientError({
        code: "api_error",
        message: "initialize result is invalid",
      });
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<SlackRpcToolCallResult> {
    const toolName = asString(name);
    if (!toolName) {
      throw new SlackRpcClientError({
        code: "api_error",
        message: "tool name is required",
      });
    }

    await this.initializeIfNeeded();

    try {
      return await this.callToolInternal(toolName, args);
    } catch (error) {
      if (!this.shouldReinitialize(error)) {
        throw error;
      }
      this.sessionId = null;
      await this.initializeIfNeeded(true);
      return await this.callToolInternal(toolName, args);
    }
  }

  private async callToolInternal(
    name: string,
    args: Record<string, unknown>
  ): Promise<SlackRpcToolCallResult> {
    let raw: unknown;
    try {
      raw = await this.sendJsonRpc("tools/call", {
        name,
        arguments: args,
      });
    } catch (error) {
      if (error instanceof SlackRpcClientError && error.code === "timeout") {
        throw new SlackRpcClientError({
          code: error.code,
          status: error.status,
          message: `${error.message} tool=${name}`,
        });
      }
      throw error;
    }
    const payload = asRecord(raw);
    if (!payload) {
      throw new SlackRpcClientError({
        code: "api_error",
        message: `tools/call(${name}) returned invalid payload`,
      });
    }

    const text = extractText(payload.content);
    return {
      isError: payload.isError === true,
      structuredContent: payload.structuredContent,
      text,
      rawResult: raw,
    };
  }

  private shouldReinitialize(error: unknown): boolean {
    if (!(error instanceof SlackRpcClientError)) {
      return false;
    }
    if (error.status === 404) {
      return true;
    }
    const lowered = error.message.toLowerCase();
    return lowered.includes("session");
  }

  private async sendJsonRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const id = this.requestId++;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.sessionId && method !== "initialize") {
      headers[SESSION_HEADER] = this.sessionId;
    }

    try {
      const response = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params,
        }),
        signal: controller.signal,
      });

      const receivedSession = response.headers.get(SESSION_HEADER);
      if (receivedSession) {
        this.sessionId = receivedSession;
      }

      const rawText = await response.text();
      const json = this.parseJson(rawText);

      if (!response.ok) {
        throw new SlackRpcClientError({
          code: "integration_unavailable",
          status: response.status,
          message: `slack rpc request failed: method=${method} status=${response.status}`,
        });
      }

      const envelope = asRecord(json);
      if (!envelope) {
        throw new SlackRpcClientError({
          code: "api_error",
          message: `slack rpc response is not a JSON object: method=${method}`,
        });
      }

      const errorField = asRecord(envelope.error);
      if (errorField) {
        const message = asString(errorField.message) ?? `slack rpc error: method=${method}`;
        throw new SlackRpcClientError({
          code: "api_error",
          message,
          status: response.status,
        });
      }

      if (!Object.prototype.hasOwnProperty.call(envelope, "result")) {
        throw new SlackRpcClientError({
          code: "api_error",
          message: `slack rpc result is missing: method=${method}`,
        });
      }

      return envelope.result;
    } catch (error) {
      if (error instanceof SlackRpcClientError) {
        throw error;
      }
      if (isAbortError(error)) {
        throw new SlackRpcClientError({
          code: "timeout",
          message: `slack rpc request timeout: method=${method} timeout_ms=${this.timeoutMs}`,
        });
      }
      throw new SlackRpcClientError({
        code: "integration_unavailable",
        message: `slack rpc request failed: method=${method} reason=${toReason(error)}`,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseJson(rawText: string): unknown {
    const trimmed = rawText.trim();
    if (!trimmed) {
      return {};
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new SlackRpcClientError({
        code: "api_error",
        message: "slack rpc response is not valid JSON",
      });
    }
  }
}

function extractText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const item of content) {
    const record = asRecord(item);
    const text = asString(record?.text);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function isAbortError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "AbortError";
  }
  const reason = toReason(error).toLowerCase();
  return reason.includes("abort");
}

function toReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
