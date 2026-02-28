import * as ChatHandler from "../../src/assistant/chat-handler.js";
import * as StreamEventBridge from "../../src/assistant/stream-event-bridge.js";
import { resetCommandQueueForTest } from "../../src/assistant/command-queue.js";
import { resetSystemEventQueueForTest } from "../../src/assistant/system-event-queue.js";

const BASE_CHAT_HANDLER_CONFIG = {
  dataDir: "/tmp/test-data",
  workspaceDir: "/tmp/test-workspace",
  timezone: "Asia/Tokyo",
  idempotencyTtlSec: 300,
} as const;

export function resetChatHandlerTestState(): void {
  ChatHandler.resetForTest();
  StreamEventBridge.resetForTest();
  resetSystemEventQueueForTest();
  resetCommandQueueForTest();
}

export function configureChatHandlerForTest(runAgent: ChatHandler.AgentRunFn): void {
  ChatHandler.configure({
    runAgent,
    ...BASE_CHAT_HANDLER_CONFIG,
  });
}

export function initializeChatHandlerForTest(runAgent: ChatHandler.AgentRunFn): void {
  resetChatHandlerTestState();
  configureChatHandlerForTest(runAgent);
}
