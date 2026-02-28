import type { NormalizedEvent } from "../core/events.js";

export type RouteDecision = {
  run: boolean;
  pending: boolean;
  system: boolean;
  drop: boolean;
  reason?: string;
};

export type RouteDecisionDraft = Partial<RouteDecision> & {
  reason?: string;
};

export type RouteBaseState = "idle" | "run" | "pending" | "drop";
export type RouterOutcome = "run" | "pending";
export type SelfMessageState = "self" | "non-self" | "unknown";
export type RouteEventKind = "post" | "reaction" | "notification" | "other";

type Transition = {
  mode: "fixed" | "router";
  state?: RouteBaseState;
  system: boolean;
  reason?: string;
};

type TransitionTable = Record<SelfMessageState, Record<RouteEventKind, Transition>>;

const TRANSITION_TABLE: TransitionTable = {
  self: {
    post: { mode: "fixed", state: "drop", system: false, reason: "self-message" },
    reaction: { mode: "fixed", state: "drop", system: false, reason: "self-message" },
    notification: { mode: "fixed", state: "drop", system: false, reason: "self-message" },
    other: { mode: "fixed", state: "drop", system: false, reason: "self-message" },
  },
  "non-self": {
    post: { mode: "router", system: false },
    reaction: { mode: "router", system: true },
    notification: { mode: "router", system: true },
    other: { mode: "fixed", state: "drop", system: false, reason: "unsupported-kind" },
  },
  unknown: {
    post: { mode: "fixed", state: "drop", system: false, reason: "self-unknown-post-failsafe" },
    reaction: {
      mode: "fixed",
      state: "idle",
      system: true,
      reason: "self-unknown-system-only",
    },
    notification: {
      mode: "fixed",
      state: "idle",
      system: true,
      reason: "self-unknown-system-only",
    },
    other: { mode: "fixed", state: "drop", system: false, reason: "unsupported-kind" },
  },
};

export type EvaluateRouteStateInput = {
  selfState: SelfMessageState;
  eventKind: RouteEventKind;
  routerOutcome?: RouterOutcome;
  reason?: string;
};

function toDecision(state: RouteBaseState, system: boolean, reason?: string): RouteDecisionDraft {
  switch (state) {
    case "run":
      return { run: true, pending: false, drop: false, system, reason };
    case "pending":
      return { run: false, pending: true, drop: false, system, reason };
    case "drop":
      return { run: false, pending: false, drop: true, system: false, reason };
    case "idle":
    default:
      return { run: false, pending: false, drop: false, system, reason };
  }
}

function bool(value: unknown): boolean {
  return value === true;
}

export function normalizeRouteDecision(draft: RouteDecisionDraft): RouteDecision {
  const normalized: RouteDecision = {
    run: bool(draft.run),
    pending: bool(draft.pending),
    system: bool(draft.system),
    drop: bool(draft.drop),
    reason: draft.reason,
  };

  if (normalized.run && normalized.pending) {
    throw new Error("invalid route decision: run and pending cannot both be true");
  }

  if (normalized.drop && (normalized.run || normalized.pending || normalized.system)) {
    throw new Error("invalid route decision: drop must be exclusive");
  }

  return normalized;
}

export function evaluateRouteState(input: EvaluateRouteStateInput): RouteDecision {
  const transition = TRANSITION_TABLE[input.selfState][input.eventKind];
  const state: RouteBaseState =
    transition.mode === "router" ? (input.routerOutcome ?? "run") : (transition.state ?? "idle");
  return normalizeRouteDecision(
    toDecision(state, transition.system, input.reason ?? transition.reason)
  );
}

export function routeEventKindFromEvent(event: NormalizedEvent): RouteEventKind {
  if (event.kind === "post" || event.kind === "reaction" || event.kind === "notification") {
    return event.kind;
  }
  return "other";
}
