export type DebugEventKind = "raw_fetch" | "raw_ws" | "normalized";

export type CollectorDebugEvent = {
  source: "slack-adapter";
  kind: DebugEventKind;
  at: string;
  payload: unknown;
};

type DebugListener = (event: CollectorDebugEvent) => void;

export interface HttpLikeRequest {
  method?: string;
  url?: string;
  on(event: "close", handler: () => void): void;
}

export interface HttpLikeResponse {
  statusCode?: number;
  setHeader(name: string, value: string): void;
  write(chunk: string): void;
  end(chunk?: string): void;
}

export class DebugEventHub {
  private readonly listeners = new Set<DebugListener>();

  publish(event: CollectorDebugEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  subscribe(listener: DebugListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

export function toSseDebugFrame(event: CollectorDebugEvent): string {
  return `event: debug\ndata: ${JSON.stringify(event)}\n\n`;
}

export function attachDebugSseClient(response: HttpLikeResponse, hub: DebugEventHub): () => void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.write("retry: 1000\n\n");

  return hub.subscribe((event) => {
    response.write(toSseDebugFrame(event));
  });
}

export function handleDebugUiRequest(
  request: HttpLikeRequest,
  response: HttpLikeResponse,
  hub: DebugEventHub
): boolean {
  const method = request.method?.toUpperCase();
  const path = request.url?.split("?")[0] ?? "";

  if (method === "GET" && path === "/events") {
    const detach = attachDebugSseClient(response, hub);
    request.on("close", () => {
      detach();
      response.end();
    });
    return true;
  }

  if (method === "GET" && path === "/health") {
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ status: "ok" }));
    return true;
  }

  return false;
}
