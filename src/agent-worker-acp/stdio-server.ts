import { createInterface } from "node:readline";

import { AgentRunnerAdapter } from "./adapters/agent-runner-adapter.js";
import { handleAuthenticate } from "./handlers/authenticate.js";
import { handleInitialize } from "./handlers/initialize.js";
import { handleSessionCancel } from "./handlers/session-cancel.js";
import { handleSessionLoad } from "./handlers/session-load.js";
import { handleSessionNew } from "./handlers/session-new.js";
import { handleSessionPrompt } from "./handlers/session-prompt.js";
import { WorkerSessionStore } from "./session-store.js";
import { WorkerRuntimeError } from "./errors.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
}

function writeEnvelope(envelope: unknown): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function writeSuccess(id: string | number, result: unknown): void {
  writeEnvelope({ jsonrpc: "2.0", id, result });
}

function writeError(id: string | number | null, code: number, message: string): void {
  writeEnvelope({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const sessionStore = new WorkerSessionStore({
    filePath:
      typeof process.env.ACP_WORKER_SESSION_STORE_PATH === "string" &&
      process.env.ACP_WORKER_SESSION_STORE_PATH.trim().length > 0
        ? process.env.ACP_WORKER_SESSION_STORE_PATH.trim()
        : undefined,
  });
  const enableLoadSession = process.env.ACP_ENABLE_LOAD_SESSION === "1";

  const adapter = new AgentRunnerAdapter({
    emitNotification: (notification) => {
      writeEnvelope(notification);
    },
  });

  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on("line", (line) => {
    void handleLine(line).catch((error) => {
      const message = error instanceof Error ? error.message : "unknown error";
      writeError(null, -32603, message);
    });
  });

  async function handleLine(line: string): Promise<void> {
    if (line.trim().length === 0) {
      return;
    }

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      writeError(null, -32700, "Parse error");
      return;
    }

    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      writeError(request.id ?? null, -32600, "Invalid Request");
      return;
    }

    const id = request.id;
    const params = isObject(request.params) ? request.params : {};

    try {
      if (request.method === "initialize") {
        if (id === undefined) {
          writeError(null, -32600, "initialize requires id");
          return;
        }

        const result = handleInitialize(
          {
            protocolVersion:
              typeof params.protocolVersion === "number" ? params.protocolVersion : Number.NaN,
          },
          { enableLoadSession }
        );
        writeSuccess(id, result);
        return;
      }

      if (request.method === "authenticate") {
        if (id === undefined) {
          writeError(null, -32600, "authenticate requires id");
          return;
        }

        writeSuccess(id, handleAuthenticate({ token: undefined }));
        return;
      }

      if (request.method === "session/new") {
        if (id === undefined) {
          writeError(null, -32600, "session/new requires id");
          return;
        }

        writeSuccess(
          id,
          handleSessionNew(
            { cwd: typeof params.cwd === "string" ? params.cwd : undefined },
            { sessionStore }
          )
        );
        return;
      }

      if (request.method === "session/load") {
        if (id === undefined) {
          writeError(null, -32600, "session/load requires id");
          return;
        }

        if (typeof params.sessionId !== "string") {
          writeError(id, -32602, "sessionId is required");
          return;
        }

        writeSuccess(
          id,
          handleSessionLoad(
            { sessionId: params.sessionId },
            { sessionStore },
            { enableLoadSession }
          )
        );
        return;
      }

      if (request.method === "session/prompt") {
        if (id === undefined) {
          writeError(null, -32600, "session/prompt requires id");
          return;
        }

        if (typeof params.sessionId !== "string" || typeof params.prompt !== "string") {
          writeError(id, -32602, "sessionId and prompt are required");
          return;
        }

        const result = await handleSessionPrompt(
          {
            sessionId: params.sessionId,
            prompt: params.prompt,
            meta: isObject(params.meta) ? params.meta : undefined,
          },
          { adapter }
        );

        writeSuccess(id, result);
        return;
      }

      if (request.method === "session/cancel") {
        if (id === undefined) {
          writeError(null, -32600, "session/cancel requires id");
          return;
        }
        if (typeof params.sessionId !== "string") {
          writeError(id, -32602, "sessionId is required");
          return;
        }

        writeSuccess(id, handleSessionCancel({ sessionId: params.sessionId }, { adapter }));
        return;
      }

      writeError(id ?? null, -32601, `Method not found: ${request.method}`);
    } catch (error) {
      if (error instanceof WorkerRuntimeError) {
        writeError(id ?? null, -32000, `${error.code}: ${error.message}`);
        return;
      }

      const message = error instanceof Error ? error.message : "Internal error";
      writeError(id ?? null, -32603, message);
    }
  }
}

void main();
