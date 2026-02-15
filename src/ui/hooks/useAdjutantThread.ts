import { useSyncExternalStore, useEffect, useMemo } from "react";
import { useExternalStoreRuntime, AssistantRuntimeProvider } from "@assistant-ui/react";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { createRuntime } from "../runtime.js";

export { AssistantRuntimeProvider };

const runtime = createRuntime();

export function useAdjutantThread() {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getState);

  useEffect(() => {
    runtime.loadHistory();
    runtime.loadHeartbeatSnapshot();
    const unsub = runtime.subscribeEvents();
    return unsub;
  }, []);

  const messages: ThreadMessageLike[] = useMemo(
    () =>
      state.messages.map((msg, i) => ({
        id: `msg-${i}-${msg.role}`,
        role: msg.role,
        content: msg.content,
        createdAt: new Date(msg.timestamp),
      })),
    [state.messages]
  );

  const assistantRuntime = useExternalStoreRuntime({
    messages,
    isRunning: state.isStreaming,
    convertMessage: (msg: ThreadMessageLike) => msg,
    onNew: async (msg) => {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((c) => c.type === "text")
              .map((c) => (c as { text: string }).text)
              .join("");
      if (!text.trim()) return;
      const key = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      runtime.sendMessage(text, key);
    },
    onCancel: async () => {
      runtime.abort();
    },
  });

  return { assistantRuntime, heartbeat: state.heartbeat, error: state.error };
}
