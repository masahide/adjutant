export const ACP_STOP_REASONS = [
  "end_turn",
  "cancelled",
  "max_tokens",
  "max_turn_requests",
  "refusal",
] as const;

export type AcpStopReason = (typeof ACP_STOP_REASONS)[number];

export function normalizeStopReason(input: unknown): AcpStopReason {
  if (typeof input !== "string") {
    return "end_turn";
  }

  const normalized = input.trim().toLowerCase();

  if (normalized === "cancelled" || normalized === "canceled" || normalized === "aborted") {
    return "cancelled";
  }

  if (normalized === "max_tokens" || normalized === "length") {
    return "max_tokens";
  }

  if (normalized === "max_turn_requests" || normalized === "too_many_turn_requests") {
    return "max_turn_requests";
  }

  if (normalized === "refusal" || normalized === "refused") {
    return "refusal";
  }

  if (normalized === "end_turn" || normalized === "completed" || normalized === "stop") {
    return "end_turn";
  }

  return "end_turn";
}
