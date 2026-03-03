import {
  PROCESS_RPC_METHODS,
  type CollectorIngestRequest,
  type DeliverCompletedNotification,
  type DeliverEnqueueRequest,
} from "./method-types.js";
import { isSlackNormalizedEvent } from "../../core/events.js";

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params: TParams;
}

export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: "2.0";
  method: string;
  params: TParams;
}

export interface JsonRpcSuccess<TResult = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  result: TResult;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: JsonRpcError;
}

export type ProcessRpcRequest =
  | (JsonRpcRequest<CollectorIngestRequest> & {
      method: typeof PROCESS_RPC_METHODS.COLLECTOR_INGEST;
    })
  | (JsonRpcRequest<DeliverEnqueueRequest> & {
      method: typeof PROCESS_RPC_METHODS.DELIVER_ENQUEUE;
    });

export type ProcessRpcNotification = JsonRpcNotification<DeliverCompletedNotification> & {
  method: typeof PROCESS_RPC_METHODS.DELIVER_COMPLETED;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateCollectorIngestRequest(value: unknown): value is CollectorIngestRequest {
  if (!isObject(value)) {
    return false;
  }

  return (
    isString(value.messageId) &&
    isString(value.dedupeKey) &&
    value.source === "slack" &&
    isString(value.occurredAt) &&
    isSlackNormalizedEvent(value.payload)
  );
}

export function validateDeliverEnqueueRequest(value: unknown): value is DeliverEnqueueRequest {
  if (!isObject(value)) {
    return false;
  }

  return (
    isString(value.messageId) &&
    isString(value.dedupeKey) &&
    isString(value.target) &&
    isNumber(value.attempt) &&
    isNumber(value.maxAttempts) &&
    "payload" in value &&
    (value.notBefore === undefined || isString(value.notBefore))
  );
}

export function validateDeliverCompletedNotification(
  value: unknown
): value is DeliverCompletedNotification {
  if (!isObject(value)) {
    return false;
  }

  return (
    isString(value.messageId) &&
    isString(value.finishedAt) &&
    (value.status === "completed" || value.status === "failed") &&
    (value.error === undefined || isString(value.error))
  );
}

export function validateProcessRpcRequest(value: unknown): value is ProcessRpcRequest {
  if (!isObject(value)) {
    return false;
  }

  if (value.jsonrpc !== "2.0") {
    return false;
  }

  const hasValidId = isString(value.id) || isNumber(value.id);
  if (!hasValidId || !isString(value.method)) {
    return false;
  }

  if (value.method === PROCESS_RPC_METHODS.COLLECTOR_INGEST) {
    return validateCollectorIngestRequest(value.params);
  }

  if (value.method === PROCESS_RPC_METHODS.DELIVER_ENQUEUE) {
    return validateDeliverEnqueueRequest(value.params);
  }

  return false;
}

export function validateProcessRpcNotification(value: unknown): value is ProcessRpcNotification {
  if (!isObject(value)) {
    return false;
  }

  return (
    value.jsonrpc === "2.0" &&
    value.method === PROCESS_RPC_METHODS.DELIVER_COMPLETED &&
    validateDeliverCompletedNotification(value.params)
  );
}
