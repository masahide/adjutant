import type { NormalizedEvent } from "../core/events.js";
import {
  evaluateRouteState,
  routeEventKindFromEvent,
  type RouteDecision,
  type RouteEventKind,
  type RouterOutcome,
  type SelfMessageState,
} from "./route-decision.js";

export type PrimaryClassifier = (event: NormalizedEvent) => RouterOutcome;

export type SecondaryClassifierInput = {
  event: NormalizedEvent;
  selfState: SelfMessageState;
  eventKind: RouteEventKind;
  primaryOutcome: RouterOutcome;
};

export type SecondaryClassifier = (
  input: SecondaryClassifierInput
) => Promise<RouterOutcome | undefined>;

export type TriggerFilterInput = {
  event: NormalizedEvent;
  selfState: SelfMessageState;
  primaryOutcome?: RouterOutcome;
  reason?: string;
};

export type TriggerFilter = {
  decide: (input: TriggerFilterInput) => Promise<RouteDecision>;
};

export type TriggerFilterOptions = {
  primaryClassifier?: PrimaryClassifier;
  secondaryClassifier?: SecondaryClassifier;
  secondaryTimeoutMs?: number;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
};

const DEFAULT_SECONDARY_TIMEOUT_MS = 1000;

function defaultPrimaryClassifier(_event: NormalizedEvent): RouterOutcome {
  return "run";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`secondary classifier timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function createTriggerFilter(options: TriggerFilterOptions = {}): TriggerFilter {
  const primaryClassifier = options.primaryClassifier ?? defaultPrimaryClassifier;
  const secondaryTimeoutMs = Math.max(
    1,
    options.secondaryTimeoutMs ?? DEFAULT_SECONDARY_TIMEOUT_MS
  );

  return {
    decide: async (input: TriggerFilterInput): Promise<RouteDecision> => {
      const eventKind = routeEventKindFromEvent(input.event);
      const primaryOutcome = input.primaryOutcome ?? primaryClassifier(input.event);
      let routerOutcome: RouterOutcome = primaryOutcome;

      if (options.secondaryClassifier && input.selfState === "non-self" && eventKind !== "other") {
        try {
          const secondaryOutcome = await withTimeout(
            options.secondaryClassifier({
              event: input.event,
              selfState: input.selfState,
              eventKind,
              primaryOutcome,
            }),
            secondaryTimeoutMs
          );
          if (secondaryOutcome === "run" || secondaryOutcome === "pending") {
            routerOutcome = secondaryOutcome;
          }
        } catch (error) {
          options.warn?.("secondary-classifier-fallback-to-primary", {
            reason: error instanceof Error ? error.message : String(error),
            eventKind,
            uid: input.event.uid,
          });
        }
      }

      return evaluateRouteState({
        selfState: input.selfState,
        eventKind,
        routerOutcome,
        reason: input.reason,
      });
    },
  };
}
