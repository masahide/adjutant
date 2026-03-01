import type { ChatHistoryMessage } from "../contracts/http-api.js";

interface ChatHistoryEntry {
  role: "user" | "assistant";
  content: string;
  runId?: string;
  toolCount?: number;
  timestamp: string;
}

export class ChatHistoryStore {
  private readonly bySessionKey = new Map<string, ChatHistoryEntry[]>();

  appendUserMessage(input: {
    sessionKey: string;
    runId: string;
    message: string;
    timestamp: string;
  }): void {
    this.append(input.sessionKey, {
      role: "user",
      content: input.message,
      runId: input.runId,
      timestamp: input.timestamp,
    });
  }

  appendAssistantMessage(input: {
    sessionKey: string;
    runId: string;
    message: string;
    timestamp: string;
  }): void {
    this.append(input.sessionKey, {
      role: "assistant",
      content: input.message,
      runId: input.runId,
      timestamp: input.timestamp,
    });
  }

  list(sessionKey: string): ChatHistoryMessage[] {
    return (this.bySessionKey.get(sessionKey) ?? []).map((entry) => ({
      role: entry.role,
      content: entry.content,
      runId: entry.runId,
      toolCount: entry.toolCount,
      timestamp: entry.timestamp,
    }));
  }

  private append(sessionKey: string, entry: ChatHistoryEntry): void {
    const existing = this.bySessionKey.get(sessionKey);
    if (existing !== undefined) {
      existing.push(entry);
      return;
    }
    this.bySessionKey.set(sessionKey, [entry]);
  }
}
