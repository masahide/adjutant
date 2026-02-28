import React from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useAdjutantThread } from "./hooks/useAdjutantThread.js";
import { useSidePanel } from "./hooks/useSidePanel.js";
import { SidePanelContext } from "./hooks/SidePanelContext.js";
import { Thread } from "./components/Thread.js";
import { HeartbeatIndicator } from "./components/HeartbeatIndicator.js";
import { SidePanel } from "./components/SidePanel.js";
import { HeartbeatHistoryTab } from "./components/HeartbeatHistoryTab.js";
import { AuditDetailTab } from "./components/AuditDetailTab.js";

export function App() {
  const { assistantRuntime, heartbeat, error } = useAdjutantThread();
  const { state: panelState, actions: panelActions } = useSidePanel();

  return (
    <AssistantRuntimeProvider runtime={assistantRuntime}>
      <SidePanelContext.Provider value={panelActions}>
        <div className="flex flex-col h-screen bg-background text-foreground font-[system-ui,sans-serif]">
          <header className="flex justify-between items-center px-4 py-2 border-b border-border bg-background">
            <span className="font-bold">Adjutant Assistant</span>
            <HeartbeatIndicator heartbeat={heartbeat} />
          </header>
          <div className="flex flex-1 min-h-0">
            <Thread />
            <SidePanel
              state={panelState}
              actions={panelActions}
              heartbeatContent={<HeartbeatHistoryTab />}
              auditContent={<AuditDetailTab runId={panelState.auditRunId} />}
            />
          </div>
          {error && (
            <div className="px-4 py-2 text-xs text-destructive bg-background border-t border-border">
              Error: {error}
            </div>
          )}
        </div>
      </SidePanelContext.Provider>
    </AssistantRuntimeProvider>
  );
}
