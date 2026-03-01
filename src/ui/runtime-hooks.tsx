import { createAssistantStream } from "assistant-stream";
import {
  AssistantRuntimeProvider,
  type ThreadMessage,
  type ThreadMessageLike,
  unstable_useRemoteThreadListRuntime,
  type unstable_RemoteThreadListAdapter,
  useAui,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ChatStreamEvent, ChatHistoryMessage } from "../control-plane/contracts/http-api.js";

type ThreadMetadata = {
  status: "regular" | "archived";
  remoteId: string;
  externalId?: string | undefined;
  title?: string | undefined;
};

type ChatAcceptedResponse = {
  runId: string;
  status: "accepted";
};

type ThreadRecordResponse = {
  threadId: string;
  title: string;
  archived: boolean;
};

const SSE_RECONNECT = {
  initial: 2_000,
  max: 30_000,
  factor: 1.8,
  jitter: 0.25,
  maxAttempts: 12,
} as const;

function computeBackoffDelay(attempt: number): number {
  const growth = SSE_RECONNECT.initial * SSE_RECONNECT.factor ** Math.max(0, attempt - 1);
  const bounded = Math.min(SSE_RECONNECT.max, growth);
  const jitterWindow = bounded * SSE_RECONNECT.jitter;
  const jitter = (Math.random() * 2 - 1) * jitterWindow;
  return Math.max(250, Math.round(bounded + jitter));
}

function extractThreadMessageText(message: ThreadMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "reasoning") {
        return part.text;
      }
      return "";
    })
    .join("")
    .trim();
}

function toThreadMessageLike(message: ChatHistoryMessage, index: number): ThreadMessageLike {
  return {
    id: message.runId ? `${message.role}:${message.runId}:${index}` : `${message.role}:${index}`,
    role: message.role,
    content: message.content,
    createdAt: new Date(message.timestamp),
  };
}

function parseAppendMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part !== "object" || part === null) {
        return "";
      }
      const p = part as Record<string, unknown>;
      if ((p.type === "text" || p.type === "reasoning") && typeof p.text === "string") {
        return p.text;
      }
      return "";
    })
    .join("")
    .trim();
}

function resolveThreadSessionKey(aui: ReturnType<typeof useAui>): string {
  try {
    const state = aui.threadListItem().getState();
    return state.remoteId ?? state.id ?? "main";
  } catch {
    return "main";
  }
}

function upsertAssistantMessage(
  messages: readonly ThreadMessageLike[],
  input: { runId: string; text: string }
): ThreadMessageLike[] {
  const messageId = `assistant:${input.runId}`;
  const next = [...messages];
  const index = next.findIndex((message) => message.id === messageId);
  if (index >= 0) {
    next[index] = {
      ...next[index],
      content: input.text,
    };
    return next;
  }
  next.push({
    id: messageId,
    role: "assistant",
    content: input.text,
  });
  return next;
}

function mergeHistoryMessages(messages: ChatHistoryMessage[]): ThreadMessageLike[] {
  return messages.map((message, index) => toThreadMessageLike(message, index));
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status}: ${body}`);
  }
  return (await response.json()) as T;
}

function createFallbackMainThread(): ThreadMetadata {
  return {
    status: "regular",
    remoteId: "main",
    title: "Main",
  };
}

function createThreadListAdapter(baseUrl: string): unstable_RemoteThreadListAdapter {
  const fallbackThreads = new Map<string, ThreadMetadata>([["main", createFallbackMainThread()]]);

  const listFromServer = async (): Promise<ThreadMetadata[]> => {
    const response = await fetch(`${baseUrl}/api/threads`);
    if (!response.ok) {
      throw new Error(`failed to list threads: ${response.status}`);
    }
    const records = (await response.json()) as ThreadRecordResponse[];
    return records.map((record) => ({
      status: record.archived ? "archived" : "regular",
      remoteId: record.threadId,
      title: record.title,
    }));
  };

  return {
    async list() {
      try {
        const threads = await listFromServer();
        fallbackThreads.clear();
        for (const thread of threads) {
          fallbackThreads.set(thread.remoteId, thread);
        }
      } catch {
        if (!fallbackThreads.has("main")) {
          fallbackThreads.set("main", createFallbackMainThread());
        }
      }
      return {
        threads: [...fallbackThreads.values()],
      };
    },
    async initialize(threadId: string) {
      if (threadId === "main") {
        return { remoteId: "main", externalId: undefined };
      }
      try {
        const record = await fetchJson<ThreadRecordResponse>(`${baseUrl}/api/threads`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        fallbackThreads.set(record.threadId, {
          status: record.archived ? "archived" : "regular",
          remoteId: record.threadId,
          title: record.title,
        });
        return { remoteId: record.threadId, externalId: undefined };
      } catch {
        const fallbackId = `thr_local_${Date.now()}`;
        fallbackThreads.set(fallbackId, {
          status: "regular",
          remoteId: fallbackId,
          title: "",
        });
        return { remoteId: fallbackId, externalId: undefined };
      }
    },
    async rename(remoteId: string, newTitle: string) {
      fallbackThreads.set(remoteId, {
        ...(fallbackThreads.get(remoteId) ?? { status: "regular", remoteId }),
        title: newTitle,
      });
      try {
        await fetchJson<ThreadRecordResponse>(
          `${baseUrl}/api/threads/${encodeURIComponent(remoteId)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: newTitle }),
          }
        );
      } catch {
        // Stage 2 fallback: Thread API may not exist yet.
      }
    },
    async archive(remoteId: string) {
      fallbackThreads.set(remoteId, {
        ...(fallbackThreads.get(remoteId) ?? { status: "regular", remoteId }),
        status: "archived",
      });
      try {
        await fetchJson<ThreadRecordResponse>(
          `${baseUrl}/api/threads/${encodeURIComponent(remoteId)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ archived: true }),
          }
        );
      } catch {
        // Stage 2 fallback: Thread API may not exist yet.
      }
    },
    async unarchive(remoteId: string) {
      fallbackThreads.set(remoteId, {
        ...(fallbackThreads.get(remoteId) ?? { status: "archived", remoteId }),
        status: "regular",
      });
      try {
        await fetchJson<ThreadRecordResponse>(
          `${baseUrl}/api/threads/${encodeURIComponent(remoteId)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ archived: false }),
          }
        );
      } catch {
        // Stage 2 fallback: Thread API may not exist yet.
      }
    },
    async delete(remoteId: string) {
      fallbackThreads.delete(remoteId);
      try {
        await fetch(`${baseUrl}/api/threads/${encodeURIComponent(remoteId)}`, {
          method: "DELETE",
        });
      } catch {
        // Stage 2 fallback: Thread API may not exist yet.
      }
    },
    async generateTitle(_remoteId: string, unstableMessages: readonly ThreadMessage[]) {
      const firstUser = unstableMessages.find((message) => message.role === "user");
      const source = firstUser ? extractThreadMessageText(firstUser) : "";
      const title = source.slice(0, 40).trim();
      return createAssistantStream((controller) => {
        if (title.length > 0) {
          controller.appendText(title);
        }
        controller.close();
      });
    },
    async fetch(threadId: string) {
      if (fallbackThreads.has(threadId)) {
        return fallbackThreads.get(threadId)!;
      }
      try {
        const record = await fetchJson<ThreadRecordResponse>(
          `${baseUrl}/api/threads/${encodeURIComponent(threadId)}`
        );
        const mapped: ThreadMetadata = {
          status: record.archived ? "archived" : "regular",
          remoteId: record.threadId,
          title: record.title,
        };
        fallbackThreads.set(record.threadId, mapped);
        return mapped;
      } catch {
        return {
          status: "regular",
          remoteId: threadId,
          title: threadId,
        };
      }
    },
  };
}

function useAdjutantExternalStoreRuntime(baseUrl = "") {
  const aui = useAui();
  const sessionKey = resolveThreadSessionKey(aui);
  const [messages, setMessages] = useState<ThreadMessageLike[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const runIdRef = useRef<string | undefined>(undefined);
  const eventSourceRef = useRef<EventSource | undefined>(undefined);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reconnectAttemptsRef = useRef(0);
  const lastSeqByRunIdRef = useRef(new Map<string, number>());
  const terminalRunRef = useRef<string | undefined>(undefined);
  const assistantTextByRunId = useRef(new Map<string, string>());

  const stopActiveStream = useCallback((options?: { clearRunId?: boolean }) => {
    if (reconnectTimerRef.current !== undefined) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = undefined;
    }
    if (eventSourceRef.current !== undefined) {
      eventSourceRef.current.close();
      eventSourceRef.current = undefined;
    }
    reconnectAttemptsRef.current = 0;
    if (options?.clearRunId !== false) {
      runIdRef.current = undefined;
    }
  }, []);

  const connectRunStream = useCallback(
    function connectRunStreamInternal(runId: string, fromSeq: number) {
      const eventSource = new EventSource(
        `${baseUrl}/api/chat/runs/${encodeURIComponent(runId)}/stream?seq=${fromSeq}`
      );
      eventSourceRef.current = eventSource;

      eventSource.addEventListener("chat", (rawEvent) => {
        let event: ChatStreamEvent;
        try {
          event = JSON.parse((rawEvent as MessageEvent).data) as ChatStreamEvent;
        } catch {
          return;
        }
        if (event.runId !== runId) {
          return;
        }
        const lastSeq = lastSeqByRunIdRef.current.get(runId) ?? -1;
        if (event.seq <= lastSeq) {
          return;
        }
        lastSeqByRunIdRef.current.set(runId, event.seq);
        reconnectAttemptsRef.current = 0;

        if (event.state === "delta" && typeof event.message === "string") {
          const current = assistantTextByRunId.current.get(event.runId) ?? "";
          const nextText = `${current}${event.message}`;
          assistantTextByRunId.current.set(event.runId, nextText);
          setMessages((previous) =>
            upsertAssistantMessage(previous, { runId: event.runId, text: nextText })
          );
          return;
        }

        if (event.state === "final") {
          const nextText =
            typeof event.message === "string"
              ? event.message
              : (assistantTextByRunId.current.get(event.runId) ?? "");
          setMessages((previous) =>
            upsertAssistantMessage(previous, { runId: event.runId, text: nextText })
          );
          assistantTextByRunId.current.delete(event.runId);
          lastSeqByRunIdRef.current.delete(event.runId);
          terminalRunRef.current = runId;
          setIsRunning(false);
          stopActiveStream();
          return;
        }

        if (event.state === "aborted") {
          assistantTextByRunId.current.delete(event.runId);
          lastSeqByRunIdRef.current.delete(event.runId);
          terminalRunRef.current = runId;
          setIsRunning(false);
          stopActiveStream();
          return;
        }

        if (event.state === "error") {
          const errorText = event.errorMessage ?? "run failed";
          setMessages((previous) =>
            upsertAssistantMessage(previous, {
              runId: event.runId,
              text: `Error: ${errorText}`,
            })
          );
          assistantTextByRunId.current.delete(event.runId);
          lastSeqByRunIdRef.current.delete(event.runId);
          terminalRunRef.current = runId;
          setIsRunning(false);
          stopActiveStream();
        }
      });

      eventSource.onerror = () => {
        if (eventSourceRef.current === eventSource) {
          eventSourceRef.current = undefined;
        }
        eventSource.close();

        if (terminalRunRef.current === runId) {
          return;
        }
        if (runIdRef.current !== runId) {
          return;
        }

        const nextAttempt = reconnectAttemptsRef.current + 1;
        reconnectAttemptsRef.current = nextAttempt;
        if (nextAttempt > SSE_RECONNECT.maxAttempts) {
          setIsRunning(false);
          stopActiveStream();
          return;
        }

        const nextFromSeq = (lastSeqByRunIdRef.current.get(runId) ?? -1) + 1;
        const delayMs = computeBackoffDelay(nextAttempt);
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = undefined;
          if (terminalRunRef.current === runId) {
            return;
          }
          if (runIdRef.current !== runId) {
            return;
          }
          connectRunStreamInternal(runId, nextFromSeq);
        }, delayMs);
      };
    },
    [baseUrl, stopActiveStream]
  );

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const history = await fetchJson<{ messages: ChatHistoryMessage[] }>(
          `${baseUrl}/api/chat/history?sessionKey=${encodeURIComponent(sessionKey)}`
        );
        if (disposed) {
          return;
        }
        setMessages(mergeHistoryMessages(history.messages));
        setIsRunning(false);
        runIdRef.current = undefined;
        lastSeqByRunIdRef.current.clear();
        assistantTextByRunId.current.clear();
      } catch {
        if (disposed) {
          return;
        }
        setMessages([]);
        runIdRef.current = undefined;
        lastSeqByRunIdRef.current.clear();
        assistantTextByRunId.current.clear();
        setIsRunning(false);
      }
    })();
    return () => {
      disposed = true;
      stopActiveStream({ clearRunId: true });
      terminalRunRef.current = undefined;
      lastSeqByRunIdRef.current.clear();
      assistantTextByRunId.current.clear();
    };
  }, [baseUrl, sessionKey, stopActiveStream]);

  const onCancel = useCallback(async () => {
    const currentRunId = runIdRef.current;
    terminalRunRef.current = currentRunId;
    if (currentRunId !== undefined) {
      lastSeqByRunIdRef.current.delete(currentRunId);
      assistantTextByRunId.current.delete(currentRunId);
    }
    stopActiveStream({ clearRunId: true });
    try {
      await fetch(`${baseUrl}/api/chat/abort`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionKey,
          runId: currentRunId,
        }),
      });
    } finally {
      setIsRunning(false);
    }
  }, [baseUrl, sessionKey, stopActiveStream]);

  const onNew = useCallback(
    async (message: { content: unknown }) => {
      const text = parseAppendMessageText(message.content);
      if (text.length === 0) {
        return;
      }

      const userMessage: ThreadMessageLike = {
        id: `user:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        role: "user",
        content: text,
      };
      setMessages((previous) => [...previous, userMessage]);
      setIsRunning(true);

      try {
        const accepted = await fetchJson<ChatAcceptedResponse>(`${baseUrl}/api/chat/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionKey,
            message: text,
            idempotencyKey: `ui_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          }),
        });

        runIdRef.current = accepted.runId;
        terminalRunRef.current = undefined;
        reconnectAttemptsRef.current = 0;
        lastSeqByRunIdRef.current.set(accepted.runId, -1);
        assistantTextByRunId.current.set(accepted.runId, "");
        stopActiveStream({ clearRunId: false });
        connectRunStream(accepted.runId, 0);
      } catch {
        setIsRunning(false);
      }
    },
    [baseUrl, connectRunStream, sessionKey, stopActiveStream]
  );

  return useExternalStoreRuntime({
    messages,
    convertMessage: (message) => message,
    isRunning,
    onNew,
    onCancel,
  });
}

export function useAdjutantAssistantRuntime(baseUrl = "") {
  const adapter = useMemo(() => createThreadListAdapter(baseUrl), [baseUrl]);
  return unstable_useRemoteThreadListRuntime({
    runtimeHook: () => useAdjutantExternalStoreRuntime(baseUrl),
    adapter,
  });
}

export { AssistantRuntimeProvider };
