import type { DeliverCompletedNotification } from "../contracts/process-rpc/method-types.js";

export interface DeliverCompletionState {
  messageId: string;
  status: "completed" | "failed";
  finishedAt: string;
  error?: string;
}

export interface DeliverApplyResult {
  applied: boolean;
  duplicate: boolean;
  final: DeliverCompletionState;
}

function sameState(a: DeliverCompletionState, b: DeliverCompletionState): boolean {
  return a.status === b.status && a.finishedAt === b.finishedAt && a.error === b.error;
}

export class DeliverCompletionStore {
  private readonly byMessageId = new Map<string, DeliverCompletionState>();

  apply(event: DeliverCompletedNotification): DeliverApplyResult {
    const next: DeliverCompletionState = {
      messageId: event.messageId,
      status: event.status,
      finishedAt: event.finishedAt,
      error: event.error,
    };

    const current = this.byMessageId.get(event.messageId);
    if (current === undefined) {
      this.byMessageId.set(event.messageId, next);
      return {
        applied: true,
        duplicate: false,
        final: next,
      };
    }

    if (sameState(current, next)) {
      return {
        applied: false,
        duplicate: true,
        final: current,
      };
    }

    if (current.status === "completed" && next.status === "failed") {
      return {
        applied: false,
        duplicate: false,
        final: current,
      };
    }

    if (current.status === "failed" && next.status === "completed") {
      this.byMessageId.set(event.messageId, next);
      return {
        applied: true,
        duplicate: false,
        final: next,
      };
    }

    this.byMessageId.set(event.messageId, next);
    return {
      applied: true,
      duplicate: false,
      final: next,
    };
  }

  get(messageId: string): DeliverCompletionState | undefined {
    return this.byMessageId.get(messageId);
  }
}
