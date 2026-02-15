import React from "react";
import type { HeartbeatEventPayload } from "../../assistant/types.js";

type Props = {
  heartbeat: HeartbeatEventPayload | null;
};

const BADGE_STYLES: Record<string, React.CSSProperties> = {
  ok: { background: "#22c55e", color: "#fff" },
  alert: { background: "#f59e0b", color: "#000" },
  error: { background: "#ef4444", color: "#fff" },
};

export function HeartbeatIndicator({ heartbeat }: Props) {
  if (!heartbeat) {
    return (
      <div style={{ padding: "4px 8px", fontSize: "12px", color: "#888" }}>
        Heartbeat: waiting...
      </div>
    );
  }

  const indicator = heartbeat.indicatorType ?? "ok";
  const badgeStyle = BADGE_STYLES[indicator] ?? BADGE_STYLES.ok;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "4px 8px",
        fontSize: "12px",
      }}
    >
      <span
        style={{
          ...badgeStyle,
          padding: "2px 8px",
          borderRadius: "4px",
          fontWeight: "bold",
          textTransform: "uppercase",
        }}
      >
        {indicator}
      </span>
      {heartbeat.preview && <span style={{ color: "#ccc" }}>{heartbeat.preview}</span>}
    </div>
  );
}
