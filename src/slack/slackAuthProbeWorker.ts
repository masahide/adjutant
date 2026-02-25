import type { SlackAuthTestStatus } from "./slackAuthTokenStore.js";

const DEFAULT_AUTH_TEST_URL = "https://slack.com/api/auth.test";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 60_000];
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

type SlackAuthProbeResultCore = {
  status: SlackAuthTestStatus;
  triedAt: string;
  succeededAt?: string;
  teamId?: string;
  enterpriseId?: string;
  url?: string;
  userId?: string;
  errorCode?: string;
  errorMessage?: string;
};

export type SlackAuthProbeResult = SlackAuthProbeResultCore;

export type SlackAuthProbeRequest = {
  workspaceKey: string;
  xoxcToken: string;
  xoxdToken: string;
};

type WorkspaceProbeState = {
  inFlight: boolean;
  retryAttempt: number;
  invalidTokenKey?: string;
  nextRetryAt: number;
  timer?: unknown;
  latestRequest?: SlackAuthProbeRequest;
};

export type SlackAuthProbeWorkerOptions = {
  fetchFn?: typeof fetch;
  authTestUrl?: string;
  timeoutMs?: number;
  retryDelaysMs?: number[];
  nowMs?: () => number;
  setTimer?: (fn: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onResult: (input: {
    workspaceKey: string;
    tokenKey: string;
    result: SlackAuthProbeResult;
  }) => Promise<void> | void;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
};

export class SlackAuthProbeWorker {
  private readonly fetchFn: typeof fetch;
  private readonly authTestUrl: string;
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: number[];
  private readonly nowMs: () => number;
  private readonly setTimer: (fn: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onResult: (input: {
    workspaceKey: string;
    tokenKey: string;
    result: SlackAuthProbeResult;
  }) => Promise<void> | void;
  private readonly onWarn?: (message: string, meta?: Record<string, unknown>) => void;

  private readonly states = new Map<string, WorkspaceProbeState>();
  private readonly runningTasks = new Set<Promise<void>>();

  constructor(options: SlackAuthProbeWorkerOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.authTestUrl = asString(options.authTestUrl) ?? DEFAULT_AUTH_TEST_URL;
    this.timeoutMs =
      typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.floor(options.timeoutMs))
        : DEFAULT_TIMEOUT_MS;
    this.retryDelaysMs =
      Array.isArray(options.retryDelaysMs) && options.retryDelaysMs.length > 0
        ? options.retryDelaysMs
            .map((value) =>
              typeof value === "number" && Number.isFinite(value)
                ? Math.max(1, Math.floor(value))
                : 1
            )
            .filter((value) => value > 0)
        : [...DEFAULT_RETRY_DELAYS_MS];
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, delayMs) => setTimeout(fn, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.onResult = options.onResult;
    this.onWarn = options.onWarn;
  }

  enqueue(input: SlackAuthProbeRequest): void {
    const workspaceKey = asString(input.workspaceKey);
    const xoxcToken = asString(input.xoxcToken);
    const xoxdToken = asString(input.xoxdToken);
    if (!workspaceKey || !xoxcToken || !xoxdToken) {
      return;
    }

    const tokenKey = `${xoxcToken}\n${xoxdToken}`;
    const state = this.states.get(workspaceKey) ?? {
      inFlight: false,
      retryAttempt: 0,
      nextRetryAt: 0,
    };
    state.latestRequest = { workspaceKey, xoxcToken, xoxdToken };
    this.states.set(workspaceKey, state);

    if (state.invalidTokenKey === tokenKey) {
      return;
    }
    if (state.inFlight) {
      return;
    }

    const now = this.nowMs();
    if (state.nextRetryAt > now) {
      this.scheduleRetry(workspaceKey, state, state.nextRetryAt - now);
      return;
    }

    this.startProbe(workspaceKey, tokenKey, state.latestRequest, state);
  }

  async flush(): Promise<void> {
    if (this.runningTasks.size === 0) {
      return;
    }
    await Promise.all([...this.runningTasks]);
  }

  resetForTest(): void {
    for (const state of this.states.values()) {
      if (state.timer !== undefined) {
        this.clearTimer(state.timer);
      }
    }
    this.states.clear();
    this.runningTasks.clear();
  }

  private scheduleRetry(workspaceKey: string, state: WorkspaceProbeState, delayMs: number): void {
    if (state.timer !== undefined) {
      return;
    }
    state.timer = this.setTimer(
      () => {
        const current = this.states.get(workspaceKey);
        if (!current) {
          return;
        }
        current.timer = undefined;
        const request = current.latestRequest;
        if (!request) {
          return;
        }
        this.enqueue(request);
      },
      Math.max(1, Math.floor(delayMs))
    );
  }

  private startProbe(
    workspaceKey: string,
    tokenKey: string,
    request: SlackAuthProbeRequest,
    state: WorkspaceProbeState
  ): void {
    state.inFlight = true;
    const task = this.runProbe(workspaceKey, tokenKey, request, state)
      .catch((error) => {
        this.onWarn?.("slack-auth-probe-worker-unhandled-error", {
          workspaceKey,
          reason: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        state.inFlight = false;
        this.runningTasks.delete(task);
      });
    this.runningTasks.add(task);
  }

  private async runProbe(
    workspaceKey: string,
    tokenKey: string,
    request: SlackAuthProbeRequest,
    state: WorkspaceProbeState
  ): Promise<void> {
    const result = await this.callAuthTest(request);

    try {
      await this.onResult({ workspaceKey, tokenKey, result });
    } catch (error) {
      this.onWarn?.("slack-auth-probe-worker-on-result-failed", {
        workspaceKey,
        status: result.status,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    if (result.status === "ok") {
      state.retryAttempt = 0;
      state.invalidTokenKey = undefined;
      state.nextRetryAt = 0;
      return;
    }

    if (result.status === "invalid_auth") {
      state.retryAttempt = 0;
      state.invalidTokenKey = tokenKey;
      state.nextRetryAt = 0;
      return;
    }

    if (result.status === "rate_limited" || result.status === "network_error") {
      state.retryAttempt += 1;
      const index = Math.max(0, Math.min(this.retryDelaysMs.length - 1, state.retryAttempt - 1));
      const delayMs =
        this.retryDelaysMs[index] ?? this.retryDelaysMs[this.retryDelaysMs.length - 1];
      state.nextRetryAt = this.nowMs() + delayMs;
      this.scheduleRetry(workspaceKey, state, delayMs);
      return;
    }

    state.retryAttempt = 0;
    state.nextRetryAt = 0;
  }

  private async callAuthTest(input: SlackAuthProbeRequest): Promise<SlackAuthProbeResult> {
    const triedAt = new Date(this.nowMs()).toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    const form = new URLSearchParams();
    form.set("token", input.xoxcToken);

    try {
      const response = await this.fetchFn(this.authTestUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.xoxcToken}`,
          Cookie: `d=${input.xoxdToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": DEFAULT_USER_AGENT,
          "Accept-Language": "en-US,en;q=0.9",
        },
        body: form.toString(),
        signal: controller.signal,
      });

      if (response.status === 429) {
        return {
          status: "rate_limited",
          triedAt,
          errorCode: "ratelimited",
          errorMessage: "rate limited",
        };
      }

      const parsed = (await response.json().catch(() => null)) as unknown;
      const payload = asRecord(parsed);
      if (!payload) {
        return {
          status: "api_error",
          triedAt,
          errorCode: "invalid_json",
          errorMessage: "invalid auth.test response",
        };
      }

      if (payload.ok !== true) {
        const errorCode = asString(payload.error);
        if (errorCode === "invalid_auth" || errorCode === "not_authed") {
          return {
            status: "invalid_auth",
            triedAt,
            errorCode,
            errorMessage: "invalid auth",
          };
        }
        if (errorCode === "ratelimited" || errorCode === "rate_limited") {
          return {
            status: "rate_limited",
            triedAt,
            errorCode,
            errorMessage: "rate limited",
          };
        }
        return {
          status: "api_error",
          triedAt,
          errorCode,
          errorMessage: errorCode ?? "auth.test failed",
        };
      }

      return {
        status: "ok",
        triedAt,
        succeededAt: triedAt,
        teamId: asString(payload.team_id),
        enterpriseId: asString(payload.enterprise_id),
        url: asString(payload.url),
        userId: asString(payload.user_id),
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return {
          status: "network_error",
          triedAt,
          errorCode: "timeout",
          errorMessage: "auth.test timeout",
        };
      }
      return {
        status: "network_error",
        triedAt,
        errorCode: "network_error",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
