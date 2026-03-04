import {
  PROCESS_RPC_METHODS,
  type CollectorIngestResponse,
  type DeliverEnqueueResponse,
} from "../../contracts/process-rpc/method-types.js";
import type {
  JsonRpcFailure,
  JsonRpcRequest,
  JsonRpcSuccess,
} from "../../contracts/process-rpc/rpc-types.js";
import { validateProcessRpcRequest } from "../../contracts/process-rpc/rpc-types.js";
import { DeliverEnqueueHandler, DeliverValidationError } from "./deliver-handler.js";
import { CollectorIngestHandler, IngestValidationError } from "./ingest-handler.js";

type JsonRpcId = string | number;

export type ProcessRpcServerOptions = {
  ingestHandler: CollectorIngestHandler;
  deliverHandler?: DeliverEnqueueHandler;
};

function success<TResult>(id: JsonRpcId, result: TResult): JsonRpcSuccess<TResult> {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function failure(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data,
    },
  };
}

export class ProcessRpcServer {
  constructor(private readonly options: ProcessRpcServerOptions) {}

  async handleRequest(
    raw: unknown
  ): Promise<JsonRpcSuccess<CollectorIngestResponse | DeliverEnqueueResponse> | JsonRpcFailure> {
    if (!validateProcessRpcRequest(raw)) {
      return failure(null, -32600, "INVALID_REQUEST");
    }

    if (raw.method === PROCESS_RPC_METHODS.COLLECTOR_INGEST) {
      try {
        const accepted = await this.options.ingestHandler.accept(raw.params);
        return success(raw.id, accepted);
      } catch (error) {
        if (error instanceof IngestValidationError) {
          return failure(raw.id, -32600, "INVALID_REQUEST", { message: error.message });
        }
        return failure(raw.id, -32000, "DOWNSTREAM_ERROR");
      }
    }

    if (raw.method === PROCESS_RPC_METHODS.DELIVER_ENQUEUE) {
      if (this.options.deliverHandler === undefined) {
        return failure(raw.id, -32601, "METHOD_NOT_SUPPORTED");
      }
      try {
        const accepted = await this.options.deliverHandler.accept(raw.params);
        return success(raw.id, accepted);
      } catch (error) {
        if (error instanceof DeliverValidationError) {
          return failure(raw.id, -32600, "INVALID_REQUEST", { message: error.message });
        }
        return failure(raw.id, -32000, "DOWNSTREAM_ERROR");
      }
    }

    return failure(raw.id, -32601, "METHOD_NOT_FOUND");
  }
}

export function parseJsonRpcRequestLine(line: string): JsonRpcRequest | JsonRpcFailure {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!validateProcessRpcRequest(parsed)) {
      return failure(null, -32600, "INVALID_REQUEST");
    }
    return parsed;
  } catch {
    return failure(null, -32700, "PARSE_ERROR");
  }
}
