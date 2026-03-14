import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

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

type PendingJournalEntry = {
  sourcePath: string;
  lineNumber: number;
  journal: JournalEntry;
};

export interface ChatHistoryStoreOptions {
  journalDir?: string;
  legacyJournalPath?: string;
}

export class ChatHistoryStore {
  private readonly bySessionKey = new Map<string, ChatHistoryEntry[]>();
  private readonly journalDir: string | undefined;
  private readonly legacyJournalPath: string | undefined;

  constructor(options?: ChatHistoryStoreOptions) {
    this.journalDir = options?.journalDir;
    this.legacyJournalPath = options?.legacyJournalPath;
  }

  async initialize(): Promise<void> {
    const pending: PendingJournalEntry[] = [];
    for (const journalPath of await this.listJournalPaths()) {
      let raw: string;
      try {
        raw = await readFile(journalPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
      const lines = raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      for (const [index, line] of lines.entries()) {
        try {
          const entry = JSON.parse(line) as JournalEntry;
          if (
            typeof entry.sessionKey !== "string" ||
            (entry.role !== "user" && entry.role !== "assistant") ||
            typeof entry.timestamp !== "string"
          ) {
            continue;
          }
          pending.push({
            sourcePath: journalPath,
            lineNumber: index,
            journal: entry,
          });
        } catch {
          // skip invalid lines
        }
      }
    }

    pending
      .sort((left, right) => {
        const leftTime = Date.parse(left.journal.timestamp);
        const rightTime = Date.parse(right.journal.timestamp);
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
          return leftTime - rightTime;
        }
        if (left.sourcePath !== right.sourcePath) {
          return left.sourcePath.localeCompare(right.sourcePath);
        }
        return left.lineNumber - right.lineNumber;
      })
      .forEach((item) => {
        this.appendMemory(item.journal.sessionKey, {
          role: item.journal.role,
          content: item.journal.content,
          runId: item.journal.runId,
          toolCount: item.journal.toolCount,
          timestamp: item.journal.timestamp,
        });
      });
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
    const journalRoot = join(stateDir, "journal", "control-plane");
    return new ChatHistoryStore({
      journalDir: join(journalRoot, "chat-history"),
      legacyJournalPath: join(journalRoot, "chat-history.jsonl"),
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
    const journalPath = this.resolveJournalPath(entry.timestamp);
    if (journalPath === undefined) {
      return;
    }
    try {
      await mkdir(dirname(journalPath), { recursive: true });
      const journalEntry: JournalEntry = { sessionKey, ...entry };
      await appendFile(journalPath, `${JSON.stringify(journalEntry)}\n`, "utf8");
    } catch {
      // journal write failure is non-fatal; in-memory state is still authoritative.
    }
  }

  private resolveJournalPath(timestamp: string): string | undefined {
    if (this.journalDir !== undefined) {
      return join(this.journalDir, `${formatDateKey(timestamp)}.jsonl`);
    }
    return this.legacyJournalPath;
  }

  private async listJournalPaths(): Promise<string[]> {
    const paths = new Set<string>();
    if (this.legacyJournalPath !== undefined) {
      paths.add(resolve(this.legacyJournalPath));
    }
    if (this.journalDir !== undefined) {
      const root = resolve(this.journalDir);
      let fileNames: string[] = [];
      try {
        fileNames = await readdir(root, { encoding: "utf8" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      for (const fileName of fileNames.sort((left, right) => left.localeCompare(right))) {
        if (!fileName.toLowerCase().endsWith(".jsonl")) {
          continue;
        }
        const candidate = resolve(join(root, fileName));
        const rel = relative(root, candidate);
        if (rel.startsWith("..")) {
          continue;
        }
        paths.add(candidate);
      }
    }
    return Array.from(paths).sort((left, right) => left.localeCompare(right));
  }
}

function formatDateKey(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return new Date().toISOString().slice(0, 10);
  }
  return new Date(parsed).toISOString().slice(0, 10);
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
