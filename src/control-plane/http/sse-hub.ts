import type { IncomingMessage, ServerResponse } from "node:http";

import type { StreamEventType } from "../contracts/http-api.js";

function writeSse(
  res: ServerResponse,
  event: StreamEventType,
  data: Record<string, unknown>
): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export class SseHub {
  private readonly clients = new Set<ServerResponse>();

  addClient(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.write(":\n\n");
    this.clients.add(res);
    req.on("close", () => {
      this.clients.delete(res);
    });
  }

  broadcast(event: StreamEventType, data: Record<string, unknown>): void {
    for (const client of this.clients) {
      writeSse(client, event, data);
    }
  }

  closeAll(): void {
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
  }
}
