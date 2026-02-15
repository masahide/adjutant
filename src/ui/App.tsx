import React, { useState, useEffect, useRef, useSyncExternalStore } from "react";
import { createRuntime } from "./runtime.js";
import { HeartbeatIndicator } from "./components/HeartbeatIndicator.js";

const runtime = createRuntime();

export function App() {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getState);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    runtime.loadHeartbeatSnapshot();
    const unsub = runtime.subscribeEvents();
    return unsub;
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || state.isStreaming) return;
    const key = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    runtime.sendMessage(input.trim(), key);
    setInput("");
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "#1a1a2e",
        color: "#e0e0e0",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "8px 16px",
          borderBottom: "1px solid #333",
          background: "#16213e",
        }}
      >
        <span style={{ fontWeight: "bold" }}>Adjutant Assistant</span>
        <HeartbeatIndicator heartbeat={state.heartbeat} />
      </div>

      {/* Thread */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        {state.messages.length === 0 && (
          <div style={{ color: "#666", textAlign: "center", marginTop: "40px" }}>
            Send a message to start a conversation.
          </div>
        )}
        {state.messages.map((msg, i) => (
          <div
            key={i}
            style={{
              alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "70%",
              padding: "10px 14px",
              borderRadius: "12px",
              background: msg.role === "user" ? "#0f3460" : "#1a1a2e",
              border: msg.role === "assistant" ? "1px solid #333" : "none",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {msg.content}
          </div>
        ))}
        {state.isStreaming && <div style={{ color: "#888", fontSize: "12px" }}>Thinking...</div>}
        {state.error && (
          <div style={{ color: "#ef4444", fontSize: "12px" }}>Error: {state.error}</div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Composer */}
      <form
        onSubmit={handleSubmit}
        style={{
          display: "flex",
          gap: "8px",
          padding: "12px 16px",
          borderTop: "1px solid #333",
          background: "#16213e",
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message..."
          disabled={state.isStreaming}
          style={{
            flex: 1,
            padding: "10px 14px",
            borderRadius: "8px",
            border: "1px solid #333",
            background: "#1a1a2e",
            color: "#e0e0e0",
            fontSize: "14px",
            outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={state.isStreaming || !input.trim()}
          style={{
            padding: "10px 20px",
            borderRadius: "8px",
            border: "none",
            background: state.isStreaming || !input.trim() ? "#333" : "#0f3460",
            color: "#fff",
            cursor: state.isStreaming || !input.trim() ? "not-allowed" : "pointer",
            fontSize: "14px",
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}
