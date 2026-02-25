import {
  createSlackApiError,
  createSlackApiSuccess,
  type FallbackResult,
  type SlackApiResult,
  type SlackMode,
  type SlackRouteStore,
  type SlackRoutingMode,
} from "./types.js";
import { SlackRouteError } from "./route-client.js";

function modeFromRoutingMode(routingMode: SlackRoutingMode): SlackMode {
  return routingMode === "manual_enterprise" ? "enterprise" : "team";
}

function oppositeMode(mode: SlackMode): SlackMode {
  return mode === "team" ? "enterprise" : "team";
}

function formatRouteError(error: SlackRouteError): string {
  const mode = error.mode;
  const kind = error.kind;
  const slackError = error.slackError;
  if (slackError === "schema_mismatch") {
    return `${mode}:${kind}:${slackError}:${error.message}`;
  }
  if (slackError) {
    return `${mode}:${kind}:${slackError}`;
  }
  return `${mode}:${kind}:${error.message}`;
}

function isFallbackEligible(error: SlackRouteError): boolean {
  if (error.kind === "not_supported") {
    return true;
  }
  if (error.kind === "api_error") {
    const code = error.slackError;
    if (code === "request_not_supported_for_team" || code === "not_allowed_token_type") {
      return true;
    }
  }
  return false;
}

function toSlackApiError(operationName: string, error: SlackRouteError) {
  if (error.kind === "rate_limited") {
    return createSlackApiError({
      code: "rate_limited",
      message: `${operationName} is rate limited`,
      primaryError: formatRouteError(error),
    });
  }
  if (error.kind === "auth_invalid") {
    return createSlackApiError({
      code: "auth_invalid",
      message: "xoxc/xoxd token is invalid",
      primaryError: formatRouteError(error),
    });
  }
  if (error.kind === "not_found") {
    return createSlackApiError({
      code: "not_found",
      message: `${operationName} target not found`,
      primaryError: formatRouteError(error),
    });
  }
  return createSlackApiError({
    code: "primary_failed",
    message: `${operationName} failed`,
    primaryError: formatRouteError(error),
  });
}

function normalizeWorkspaceKey(value: string | undefined): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : "global";
}

export type SlackFallbackExecutorOptions = {
  routeStore: SlackRouteStore;
  now?: () => number;
};

export class SlackFallbackExecutor {
  private readonly routeStore: SlackRouteStore;
  private readonly now: () => number;

  constructor(options: SlackFallbackExecutorOptions) {
    this.routeStore = options.routeStore;
    this.now = options.now ?? (() => Date.now());
  }

  async runWithFallback<T>(input: {
    routingMode: SlackRoutingMode;
    workspaceKey?: string;
    operationName: string;
    probeMode: () => Promise<SlackMode>;
    execute: (mode: SlackMode) => Promise<T>;
  }): Promise<SlackApiResult<FallbackResult<T>>> {
    const workspaceKey = normalizeWorkspaceKey(input.workspaceKey);
    let primaryMode: SlackMode;

    if (input.routingMode === "auto_probe") {
      const pinned = await this.routeStore.get(workspaceKey);
      if (pinned) {
        primaryMode = pinned.mode;
      } else {
        primaryMode = await input.probeMode();
        await this.routeStore.set({
          workspaceKey,
          mode: primaryMode,
          decidedAt: this.now(),
        });
      }
    } else {
      primaryMode = modeFromRoutingMode(input.routingMode);
    }

    try {
      const primaryData = await input.execute(primaryMode);
      return createSlackApiSuccess({
        modeUsed: primaryMode,
        fallbackTried: false,
        data: {
          modeUsed: primaryMode,
          fallbackTried: false,
          data: primaryData,
        },
      });
    } catch (error) {
      const primaryError =
        error instanceof SlackRouteError
          ? error
          : new SlackRouteError({
              kind: "api_error",
              mode: primaryMode,
              message: error instanceof Error ? error.message : String(error),
            });

      if (input.routingMode !== "auto_probe") {
        return toSlackApiError(input.operationName, primaryError);
      }

      if (!isFallbackEligible(primaryError)) {
        return toSlackApiError(input.operationName, primaryError);
      }

      const fallbackMode = oppositeMode(primaryMode);
      try {
        const fallbackData = await input.execute(fallbackMode);
        await this.routeStore.set({
          workspaceKey,
          mode: fallbackMode,
          decidedAt: this.now(),
        });
        return createSlackApiSuccess({
          modeUsed: fallbackMode,
          fallbackTried: true,
          data: {
            modeUsed: fallbackMode,
            fallbackTried: true,
            data: fallbackData,
          },
        });
      } catch (fallbackFailure) {
        const fallbackError =
          fallbackFailure instanceof SlackRouteError
            ? fallbackFailure
            : new SlackRouteError({
                kind: "api_error",
                mode: fallbackMode,
                message:
                  fallbackFailure instanceof Error
                    ? fallbackFailure.message
                    : String(fallbackFailure),
              });

        if (fallbackError.kind === "rate_limited") {
          return createSlackApiError({
            code: "rate_limited",
            message: `${input.operationName} fallback was rate limited`,
            primaryError: formatRouteError(primaryError),
            fallbackError: formatRouteError(fallbackError),
          });
        }

        return createSlackApiError({
          code: "fallback_failed",
          message: `${input.operationName} failed in both routes`,
          primaryError: formatRouteError(primaryError),
          fallbackError: formatRouteError(fallbackError),
        });
      }
    }
  }
}
