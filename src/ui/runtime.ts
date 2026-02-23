import type { StreamEvent, HeartbeatEventPayload } from "../assistant/types.js";

export type RuntimeMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  runId?: string;
  toolCount?: number;
};

export type RuntimeState = {
  messages: RuntimeMessage[];
  isStreaming: boolean;
  heartbeat: HeartbeatEventPayload | null;
  error: string | null;
};

type Listener = () => void;

const SSE_RECONNECT = {
  initial: 2000,
  max: 30000,
  factor: 1.8,
  jitter: 0.25,
  maxAttempts: 12,
} as const;

export function createRuntime(baseUrl: string = "") {
  let state: RuntimeState = {
    messages: [],
    isStreaming: false,
    heartbeat: null,
    error: null,
  };
  const listeners = new Set<Listener>();

  function notify() {
    for (const fn of listeners) fn();
  }

  function setState(patch: Partial<RuntimeState>) {
    state = { ...state, ...patch };
    notify();
  }

  function getState(): RuntimeState {
    return state;
  }

  function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async function sendMessage(message: string, idempotencyKey: string, sessionKey = "main") {
    setState({
      messages: [...state.messages, { role: "user", content: message, timestamp: Date.now() }],
      isStreaming: true,
      error: null,
    });

    try {
      const res = await fetch(`${baseUrl}/api/chat/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, sessionKey, idempotencyKey }),
      });

      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        setState({ isStreaming: false, error: err.error ?? `HTTP ${res.status}` });
        return;
      }

      const { runId } = (await res.json()) as { runId: string };
      subscribeRun(runId);
    } catch (err) {
      setState({
        isStreaming: false,
        error: err instanceof Error ? err.message : "Network error",
      });
    }
  }

  function subscribeRun(runId: string) {
    let attempt = 0;
    let lastSeq = -1;

    function connect() {
      const es = new EventSource(`${baseUrl}/api/chat/runs/${runId}/stream`);

      es.addEventListener("chat", (e: MessageEvent) => {
        try {
          const event = JSON.parse(e.data) as StreamEvent;

          if (event.seq <= lastSeq) return;
          lastSeq = event.seq;

          if (event.state === "delta" || event.state === "final") {
            const msg = event.message as
              | { content?: Array<{ type: string; text: string }> }
              | undefined;
            const text = msg?.content
              ?.filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("");

            if (text) {
              const msgs = [...state.messages];
              const lastMsg = msgs[msgs.length - 1];
              if (lastMsg?.role === "assistant" && state.isStreaming && lastMsg.runId === runId) {
                msgs[msgs.length - 1] = {
                  ...lastMsg,
                  content: event.state === "final" ? text : lastMsg.content + text,
                  timestamp: Date.now(),
                };
              } else {
                msgs.push({ role: "assistant", content: text, timestamp: Date.now(), runId });
              }
              setState({ messages: msgs });
            }
          }

          if (event.state === "final" || event.state === "error" || event.state === "aborted") {
            es.close();
            setState({
              isStreaming: false,
              error:
                event.state === "error"
                  ? (event.errorMessage ?? "Agent error")
                  : event.state === "aborted"
                    ? "Run was aborted"
                    : null,
            });
            if (event.state === "final") {
              void hydrateToolCount(runId);
            }
          }
        } catch {
          // ignore parse errors
        }
      });

      es.onerror = () => {
        es.close();
        attempt++;
        if (attempt >= SSE_RECONNECT.maxAttempts) {
          setState({ isStreaming: false, error: "Connection lost after max retries" });
          return;
        }
        const delay = computeBackoff(attempt);
        setTimeout(connect, delay);
      };
    }

    connect();
  }

  function countCompletedTools(tools: unknown[]): number {
    let completed = 0;
    for (const tool of tools) {
      if (!tool || typeof tool !== "object") {
        continue;
      }
      const record = tool as Record<string, unknown>;
      if (typeof record.endedAt === "string" && record.endedAt.trim()) {
        completed += 1;
      }
    }
    return completed;
  }

  async function hydrateToolCount(runId: string): Promise<void> {
    const maxAttempts = 4;
    let bestCompletedCount: number | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const delayMs = attempt === 0 ? 0 : attempt === 1 ? 250 : attempt === 2 ? 750 : 1500;
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      try {
        const res = await fetch(`${baseUrl}/api/chat/runs/${encodeURIComponent(runId)}/audit`);
        if (!res.ok) {
          return;
        }
        const body = (await res.json()) as { tools?: unknown; runEnded?: unknown };
        if (!Array.isArray(body.tools)) {
          return;
        }
        const completedCount = countCompletedTools(body.tools);
        if (bestCompletedCount === null || completedCount > bestCompletedCount) {
          bestCompletedCount = completedCount;
        }
        const runEnded = body.runEnded === true;
        if (runEnded) {
          break;
        }
      } catch {
        if (attempt >= maxAttempts - 1) {
          break;
        }
        continue;
      }
    }

    if (bestCompletedCount === null) {
      return;
    }

    const nextMessages = [...state.messages];
    for (let i = nextMessages.length - 1; i >= 0; i -= 1) {
      const message = nextMessages[i];
      if (message?.role === "assistant" && message.runId === runId) {
        nextMessages[i] = { ...message, toolCount: bestCompletedCount };
        setState({ messages: nextMessages });
        return;
      }
    }
  }

  function extractUserMessage(text: string): string | null {
    const marker = "## User Message\n";
    const idx = text.lastIndexOf(marker);
    if (idx >= 0) {
      return text.slice(idx + marker.length).trim() || null;
    }
    // No marker means it's a context-only prompt, skip it
    if (text.includes("## Recent Session Transcript") || text.includes("## Memory")) {
      return null;
    }
    return text.trim() || null;
  }

  async function loadHistory(sessionKey = "main") {
    try {
      const res = await fetch(
        `${baseUrl}/api/chat/history?sessionKey=${encodeURIComponent(sessionKey)}`
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        messages: Array<{
          role?: string;
          content?: string | Array<{ type?: string; text?: string }>;
          timestamp?: number;
          runId?: string;
          toolCount?: number;
        }>;
      };
      if (!Array.isArray(data.messages) || data.messages.length === 0) return;

      const restored: RuntimeMessage[] = [];
      for (const msg of data.messages) {
        const role = msg.role === "user" ? "user" : msg.role === "assistant" ? "assistant" : null;
        if (!role) continue;

        let text = "";
        if (typeof msg.content === "string") {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text!)
            .join("");
        }
        if (!text.trim()) continue;

        if (role === "user") {
          const userText = extractUserMessage(text);
          if (!userText) continue;
          text = userText;
        }

        restored.push({
          role,
          content: text,
          timestamp: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
          ...(typeof msg.runId === "string" && msg.runId.trim() ? { runId: msg.runId.trim() } : {}),
          ...(typeof msg.toolCount === "number" && Number.isFinite(msg.toolCount)
            ? { toolCount: Math.max(0, Math.floor(msg.toolCount)) }
            : {}),
        });
      }
      // Keep only last 50 messages to avoid overloading the UI
      const trimmed = restored.slice(-50);
      if (trimmed.length > 0) {
        setState({ messages: trimmed });
      }
    } catch {
      // ignore
    }
  }

  async function loadHeartbeatSnapshot() {
    try {
      const res = await fetch(`${baseUrl}/api/heartbeat/last`);
      if (res.ok) {
        const data = (await res.json()) as HeartbeatEventPayload | null;
        if (data) setState({ heartbeat: data });
      }
    } catch {
      // ignore
    }
  }

  function subscribeEvents() {
    const es = new EventSource(`${baseUrl}/api/events/stream`);
    es.addEventListener("heartbeat", (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data) as HeartbeatEventPayload;
        setState({ heartbeat: payload });
      } catch {
        // ignore
      }
    });
    return () => es.close();
  }

  async function abort(sessionKey = "main") {
    try {
      await fetch(`${baseUrl}/api/chat/abort`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionKey }),
      });
      setState({ isStreaming: false });
    } catch {
      // ignore
    }
  }

  return {
    getState,
    subscribe,
    sendMessage,
    abort,
    loadHistory,
    loadHeartbeatSnapshot,
    subscribeEvents,
  };
}

export function computeBackoff(attempt: number): number {
  const { initial, max, factor, jitter } = SSE_RECONNECT;
  const base = Math.min(initial * Math.pow(factor, attempt - 1), max);
  const jitterAmount = base * jitter * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitterAmount));
}
