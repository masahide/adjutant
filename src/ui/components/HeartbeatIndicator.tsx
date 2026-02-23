import React from "react";
import type { HeartbeatEventPayload } from "../../assistant/types.js";
import { cn } from "../lib/utils.js";
import { useSidePanelActions } from "../hooks/SidePanelContext.js";

type Props = {
  heartbeat: HeartbeatEventPayload | null;
};

const BADGE_CLASSES: Record<string, string> = {
  ok: "bg-green-500 text-white",
  alert: "bg-amber-500 text-black",
  error: "bg-red-500 text-white",
};

export function HeartbeatIndicator({ heartbeat }: Props) {
  const { toggleHeartbeat } = useSidePanelActions();

  if (!heartbeat) {
    return (
      <button
        onClick={toggleHeartbeat}
        className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      >
        Heartbeat: waiting...
      </button>
    );
  }

  const indicator = heartbeat.indicatorType ?? "ok";
  const badgeClass = BADGE_CLASSES[indicator] ?? BADGE_CLASSES.ok;

  return (
    <button
      onClick={toggleHeartbeat}
      className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-accent/50 rounded transition-colors cursor-pointer"
    >
      <span className={cn("px-2 py-0.5 rounded font-bold uppercase", badgeClass)}>{indicator}</span>
      {heartbeat.preview && <span className="text-muted-foreground">{heartbeat.preview}</span>}
    </button>
  );
}
