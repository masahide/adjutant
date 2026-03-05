import type {
  DeliverCompletedNotification,
  DeliverEnqueueRequest,
} from "../../contracts/process-rpc/method-types.js";
import type { Cursor } from "../../runtime/journal-store.js";
import type { DeliverApplyResult, DeliverCompletionStore } from "../deliver-completion-store.js";
import type { DeliverQueueStore } from "./deliver-queue-store.js";

type DeliverDispatcher = {
  enqueue: (
    request: DeliverEnqueueRequest,
    options?: {
      timeoutMs?: number;
    }
  ) => Promise<unknown>;
};

export interface DeliverEnqueueAcceptedResult {
  cursor: Cursor;
  dispatchStatus: "skipped" | "accepted" | "failed";
  dispatchMessage?: string;
}

export interface DeliverCompletionApplyResult {
  applied: DeliverApplyResult;
  cursorCommitted: boolean;
}

export interface DeliverQueueCoordinatorDeps {
  queueStore: Pick<DeliverQueueStore, "append" | "commitThrough">;
  completionStore: Pick<DeliverCompletionStore, "apply">;
  resolveDispatcher?: () => DeliverDispatcher | undefined;
  dispatchTimeoutMs?: number;
}

export class DeliverQueueCoordinator {
  private readonly queueStore: Pick<DeliverQueueStore, "append" | "commitThrough">;
  private readonly completionStore: Pick<DeliverCompletionStore, "apply">;
  private readonly resolveDispatcher?: () => DeliverDispatcher | undefined;
  private readonly dispatchTimeoutMs?: number;
  private readonly cursorByMessageId = new Map<string, Cursor>();

  constructor(deps: DeliverQueueCoordinatorDeps) {
    this.queueStore = deps.queueStore;
    this.completionStore = deps.completionStore;
    this.resolveDispatcher = deps.resolveDispatcher;
    this.dispatchTimeoutMs = deps.dispatchTimeoutMs;
  }

  async accept(request: DeliverEnqueueRequest): Promise<DeliverEnqueueAcceptedResult> {
    const cursor = await this.queueStore.append({
      request,
    });
    this.cursorByMessageId.set(request.messageId, cursor);

    const dispatcher = this.resolveDispatcher?.();
    if (dispatcher === undefined) {
      return {
        cursor,
        dispatchStatus: "skipped",
      };
    }

    try {
      await dispatcher.enqueue(request, { timeoutMs: this.dispatchTimeoutMs });
      return {
        cursor,
        dispatchStatus: "accepted",
      };
    } catch (error) {
      return {
        cursor,
        dispatchStatus: "failed",
        dispatchMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async applyCompletion(
    notification: DeliverCompletedNotification
  ): Promise<DeliverCompletionApplyResult> {
    const applied = this.completionStore.apply(notification);
    const cursor = this.cursorByMessageId.get(notification.messageId);
    if (cursor === undefined) {
      return {
        applied,
        cursorCommitted: false,
      };
    }
    await this.queueStore.commitThrough(cursor);
    this.cursorByMessageId.delete(notification.messageId);
    return {
      applied,
      cursorCommitted: true,
    };
  }

  trackCursor(messageId: string, cursor: Cursor): void {
    this.cursorByMessageId.set(messageId, cursor);
  }
}
