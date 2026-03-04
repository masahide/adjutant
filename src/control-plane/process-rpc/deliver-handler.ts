import type {
  DeliverEnqueueRequest,
  DeliverEnqueueResponse,
} from "../../contracts/process-rpc/method-types.js";
import { validateDeliverEnqueueRequest } from "../../contracts/process-rpc/rpc-types.js";

export class DeliverValidationError extends Error {
  readonly code = "INVALID_REQUEST";

  constructor(message: string) {
    super(message);
    this.name = "DeliverValidationError";
  }
}

export type DeliverEnqueueHandlerOptions = {
  now?: () => Date;
  onAccept?: (request: DeliverEnqueueRequest) => Promise<void> | void;
};

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export class DeliverEnqueueHandler {
  private readonly now: () => Date;
  private readonly onAccept: DeliverEnqueueHandlerOptions["onAccept"];

  constructor(options: DeliverEnqueueHandlerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.onAccept = options.onAccept;
  }

  async accept(params: unknown): Promise<DeliverEnqueueResponse> {
    if (!validateDeliverEnqueueRequest(params)) {
      throw new DeliverValidationError("deliver/enqueue params are invalid");
    }

    if (!isPositiveInteger(params.attempt)) {
      throw new DeliverValidationError("attempt must be a positive integer");
    }
    if (!isPositiveInteger(params.maxAttempts)) {
      throw new DeliverValidationError("maxAttempts must be a positive integer");
    }
    if (params.attempt > params.maxAttempts) {
      throw new DeliverValidationError("attempt must be less than or equal to maxAttempts");
    }

    await this.onAccept?.(params);
    return {
      messageId: params.messageId,
      status: "accepted",
      acceptedAt: this.now().toISOString(),
    };
  }
}
