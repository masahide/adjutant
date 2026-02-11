import type {
  FetchPausedEvent,
  ResponseReceivedEvent,
  WebSocketFrameEvent,
} from "../src/slack/adapter.js";

export type Triggerable = {
  fetchHandlers: { requestPaused?: (payload: FetchPausedEvent) => unknown };
  networkHandlers: {
    webSocketFrameReceived?: (payload: WebSocketFrameEvent) => unknown;
    webSocketFrameSent?: (payload: WebSocketFrameEvent) => unknown;
    responseReceived?: (payload: ResponseReceivedEvent) => unknown;
  };
  triggerFetch(payload: FetchPausedEvent): Promise<void>;
  triggerNetwork(
    name: "webSocketFrameReceived" | "webSocketFrameSent" | "responseReceived",
    payload: WebSocketFrameEvent | ResponseReceivedEvent
  ): Promise<void>;
};

export const createMockSlackClient = () => {
  const fetchHandlers: { requestPaused?: (payload: FetchPausedEvent) => unknown } = {};
  const networkHandlers: {
    webSocketFrameReceived?: (payload: WebSocketFrameEvent) => unknown;
    webSocketFrameSent?: (payload: WebSocketFrameEvent) => unknown;
    responseReceived?: (payload: ResponseReceivedEvent) => unknown;
  } = {};
  const runtimeHandlers: {
    executionContextCreated?: (payload: unknown) => void;
    executionContextDestroyed?: (payload: unknown) => void;
  } = {};
  const calls: string[] = [];
  const continued: string[] = [];

  const responseBodies: Record<string, { body: string; base64Encoded: boolean }> = {};

  let runtimeToken: string | null = null;
  let runtimeEvaluate:
    | ((params: { expression?: string; contextId?: number }) => Promise<{
        result: { value: unknown };
      }>)
    | null = null;

  const client = {
    Fetch: {
      enable: async (opts: unknown) => {
        calls.push(`Fetch.enable:${JSON.stringify(opts)}`);
      },
      on(name: "requestPaused", handler: (payload: FetchPausedEvent) => unknown) {
        fetchHandlers.requestPaused = handler;
      },
      continueRequest: async ({ requestId }: { requestId: string }) => {
        continued.push(requestId);
      },
    },
    Network: {
      enable: async (opts: unknown) => {
        calls.push(`Network.enable:${JSON.stringify(opts)}`);
      },
      setCacheDisabled: async (opts: unknown) => {
        calls.push(`Network.setCacheDisabled:${JSON.stringify(opts)}`);
      },
      on(
        name: "webSocketFrameReceived" | "webSocketFrameSent" | "responseReceived",
        handler: (payload: WebSocketFrameEvent | ResponseReceivedEvent) => unknown
      ) {
        if (name === "webSocketFrameReceived") {
          networkHandlers.webSocketFrameReceived = handler as (
            payload: WebSocketFrameEvent
          ) => unknown;
        } else if (name === "webSocketFrameSent") {
          networkHandlers.webSocketFrameSent = handler as (payload: WebSocketFrameEvent) => unknown;
        } else {
          networkHandlers.responseReceived = handler as (payload: ResponseReceivedEvent) => unknown;
        }
      },
      getResponseBody: async ({ requestId }: { requestId: string }) =>
        responseBodies[requestId] ?? { body: "", base64Encoded: false },
    },
    Runtime: {
      enable: async (opts: unknown) => {
        calls.push(`Runtime.enable:${JSON.stringify(opts)}`);
      },
      on(
        name: "executionContextCreated" | "executionContextDestroyed",
        handler: (payload: unknown) => void
      ) {
        runtimeHandlers[name] = handler;
      },
      evaluate: async (params: { expression?: string; contextId?: number }) => {
        if (runtimeEvaluate) {
          return runtimeEvaluate(params);
        }
        return { result: { value: runtimeToken } };
      },
    },
  };

  return {
    client,
    calls,
    continued,
    fetchHandlers,
    networkHandlers,
    runtimeHandlers,
    responseBodies,
    setRuntimeToken(token: string | null) {
      runtimeToken = token;
    },
    setRuntimeEvaluate(
      fn: (params: { expression?: string; contextId?: number }) => Promise<{
        result: { value: unknown };
      }>
    ) {
      runtimeEvaluate = fn;
    },
    triggerExecutionContextCreated(payload: unknown) {
      const handler = runtimeHandlers.executionContextCreated;
      if (handler) handler(payload);
    },
    triggerExecutionContextDestroyed(payload: unknown) {
      const handler = runtimeHandlers.executionContextDestroyed;
      if (handler) handler(payload);
    },
    async triggerFetch(payload: FetchPausedEvent) {
      const handler = fetchHandlers.requestPaused;
      if (handler) await handler(payload);
    },
    async triggerNetwork(
      name: "webSocketFrameReceived" | "webSocketFrameSent" | "responseReceived",
      payload: WebSocketFrameEvent | ResponseReceivedEvent
    ) {
      if (name === "webSocketFrameReceived") {
        const handler = networkHandlers.webSocketFrameReceived;
        if (handler) await handler(payload as WebSocketFrameEvent);
      } else if (name === "webSocketFrameSent") {
        const handler = networkHandlers.webSocketFrameSent;
        if (handler) await handler(payload as WebSocketFrameEvent);
      } else {
        const handler = networkHandlers.responseReceived;
        if (handler) await handler(payload as ResponseReceivedEvent);
      }
    },
  };
};

export type MockSlackClient = ReturnType<typeof createMockSlackClient>;
