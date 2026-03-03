import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ChatHistoryContentPart, ChatHistoryMessage } from "../contracts/http-api.js";

export interface ToolCallSummary {
  toolCallId: string;
  toolName: string;
  status: string;
  argsText?: string;
  result?: string;
}

interface ChatHistoryEntry {
  role: "user" | "assistant";
  content: string | ChatHistoryContentPart[];
  runId?: string;
  toolCount?: number;
  timestamp: string;
}

type JournalEntry = ChatHistoryEntry & { sessionKey: string };

export interface ChatHistoryStoreOptions {
  journalPath?: string;
}

export class ChatHistoryStore {
  private readonly bySessionKey = new Map<string, ChatHistoryEntry[]>();
  private readonly journalPath: string | undefined;

  constructor(options?: ChatHistoryStoreOptions) {
    this.journalPath = options?.journalPath;
  }

  async initialize(): Promise<void> {
    if (this.journalPath === undefined) {
      return;
    }
    let raw: string;
    try {
      raw = await readFile(this.journalPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JournalEntry;
        if (
          typeof entry.sessionKey !== "string" ||
          (entry.role !== "user" && entry.role !== "assistant") ||
          typeof entry.timestamp !== "string"
        ) {
          continue;
        }
        this.appendMemory(entry.sessionKey, {
          role: entry.role,
          content: entry.content,
          runId: entry.runId,
          toolCount: entry.toolCount,
          timestamp: entry.timestamp,
        });
      } catch {
        // skip invalid lines
      }
    }
  }

  appendUserMessage(input: {
    sessionKey: string;
    runId: string;
    message: string;
    timestamp: string;
  }): void {
    const entry: ChatHistoryEntry = {
      role: "user",
      content: input.message,
      runId: input.runId,
      timestamp: input.timestamp,
    };
    this.appendMemory(input.sessionKey, entry);
    void this.appendJournal(input.sessionKey, entry);
  }

  appendAssistantMessage(input: {
    sessionKey: string;
    runId: string;
    message: string;
    thinking?: string;
    toolCalls?: ToolCallSummary[];
    timestamp: string;
  }): void {
    const content = buildStructuredContent({
      text: input.message,
      thinking: input.thinking,
      toolCalls: input.toolCalls,
    });
    const entry: ChatHistoryEntry = {
      role: "assistant",
      content,
      runId: input.runId,
      timestamp: input.timestamp,
    };
    this.appendMemory(input.sessionKey, entry);
    void this.appendJournal(input.sessionKey, entry);
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

  static fromStateDir(stateDir: string): ChatHistoryStore {
    return new ChatHistoryStore({
      journalPath: join(stateDir, "journal", "control-plane", "chat-history.jsonl"),
    });
  }

  private appendMemory(sessionKey: string, entry: ChatHistoryEntry): void {
    const existing = this.bySessionKey.get(sessionKey);
    if (existing !== undefined) {
      existing.push(entry);
      return;
    }
    this.bySessionKey.set(sessionKey, [entry]);
  }

  private async appendJournal(sessionKey: string, entry: ChatHistoryEntry): Promise<void> {
    if (this.journalPath === undefined) {
      return;
    }
    try {
      await mkdir(dirname(this.journalPath), { recursive: true });
      const journalEntry: JournalEntry = { sessionKey, ...entry };
      await appendFile(this.journalPath, `${JSON.stringify(journalEntry)}\n`, "utf8");
    } catch {
      // journal write failure is non-fatal; in-memory state is still authoritative.
    }
  }
}

function buildStructuredContent(input: {
  text: string;
  thinking?: string;
  toolCalls?: ToolCallSummary[];
}): string | ChatHistoryContentPart[] {
  const hasThinking = typeof input.thinking === "string" && input.thinking.length > 0;
  const hasToolCalls = Array.isArray(input.toolCalls) && input.toolCalls.length > 0;

  if (!hasThinking && !hasToolCalls) {
    return input.text;
  }

  const parts: ChatHistoryContentPart[] = [];
  if (hasThinking) {
    parts.push({ type: "reasoning", text: input.thinking! });
  }
  if (hasToolCalls) {
    for (const tc of input.toolCalls!) {
      const part: ChatHistoryContentPart & { type: "tool-call" } = {
        type: "tool-call",
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
      };
      if (tc.argsText) {
        part.argsText = tc.argsText;
      }
      if (tc.status === "completed") {
        part.result = tc.result ?? "done";
      } else if (tc.status === "failed") {
        part.result = tc.result ?? "failed";
        part.isError = true;
      }
      parts.push(part);
    }
  }
  if (input.text.length > 0) {
    parts.push({ type: "text", text: input.text });
  }
  return parts;
}
