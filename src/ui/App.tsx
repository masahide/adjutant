import React from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useAdjutantThread } from "./hooks/useAdjutantThread.js";
import { Thread } from "./components/Thread.js";
import { HeartbeatIndicator } from "./components/HeartbeatIndicator.js";

export function App() {
  const { assistantRuntime, heartbeat, error } = useAdjutantThread();

  return (
    <AssistantRuntimeProvider runtime={assistantRuntime}>
      <div className="flex flex-col h-screen bg-background text-foreground font-[system-ui,sans-serif]">
        <header className="flex justify-between items-center px-4 py-2 border-b border-border bg-background">
          <span className="font-bold">Adjutant Assistant</span>
          <HeartbeatIndicator heartbeat={heartbeat} />
        </header>
        <Thread />
        {error && (
          <div className="px-4 py-2 text-xs text-destructive bg-background border-t border-border">
            Error: {error}
          </div>
        )}
      </div>
    </AssistantRuntimeProvider>
  );
}
