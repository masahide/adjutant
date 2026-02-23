import React, { useCallback, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import { cn } from "../lib/utils.js";
import type { SidePanelState, SidePanelTab, SidePanelActions } from "../hooks/useSidePanel.js";

type Props = {
  state: SidePanelState;
  actions: SidePanelActions;
  heartbeatContent: React.ReactNode;
  auditContent: React.ReactNode;
};

const TABS: { key: SidePanelTab; label: string }[] = [
  { key: "heartbeat", label: "Heartbeat" },
  { key: "audit", label: "Audit" },
];

const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 240;
const MAX_WIDTH = 640;

export function SidePanel({ state, actions, heartbeatContent, auditContent }: Props) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const dragging = useRef(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragging.current = true;
      const startX = e.clientX;
      const startWidth = width;

      const onMove = (ev: PointerEvent) => {
        const delta = startX - ev.clientX;
        setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta)));
      };

      const onUp = () => {
        dragging.current = false;
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    },
    [width]
  );

  if (!state.open) return null;

  return (
    <>
      {/* Mobile overlay backdrop */}
      <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={actions.close} />

      {/* Panel */}
      <aside
        style={{ width }}
        className={cn(
          "flex flex-col border-l border-border bg-background text-foreground shrink-0",
          // Mobile: overlay
          "fixed inset-y-0 right-0 z-50",
          // Desktop: static column
          "md:relative md:inset-auto md:z-auto"
        )}
      >
        {/* Resize handle (desktop only) */}
        <div
          onPointerDown={onPointerDown}
          className="hidden md:block absolute inset-y-0 left-0 w-1.5 cursor-col-resize hover:bg-accent/40 active:bg-accent/60 transition-colors z-10"
        />

        {/* Header: tabs + close */}
        <div className="flex items-center border-b border-border px-2 py-1.5">
          <div className="flex flex-1 gap-1">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => actions.switchTab(tab.key)}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded transition-colors",
                  state.activeTab === tab.key
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <button
            onClick={actions.close}
            className="p-1 text-muted-foreground hover:text-foreground rounded transition-colors"
            aria-label="Close panel"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {state.activeTab === "heartbeat" ? heartbeatContent : auditContent}
        </div>
      </aside>
    </>
  );
}
