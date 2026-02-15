import type { StreamEvent, HeartbeatEventPayload } from "../assistant/types.js";

export type RuntimeMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
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
              if (lastMsg?.role === "assistant" && state.isStreaming) {
                msgs[msgs.length - 1] = {
                  ...lastMsg,
                  content: event.state === "final" ? text : lastMsg.content + text,
                  timestamp: Date.now(),
                };
              } else {
                msgs.push({ role: "assistant", content: text, timestamp: Date.now() });
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

  return {
    getState,
    subscribe,
    sendMessage,
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
