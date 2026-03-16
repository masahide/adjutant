import { AssistantRuntimeProvider, useAui, useAuiState } from "@assistant-ui/react";
import { useEffect, useRef } from "react";

import { TooltipProvider } from "./components/ui/tooltip.js";
import { Thread } from "./components/assistant-ui/thread.js";
import { ThreadListSidebar } from "./components/assistant-ui/thread-list.js";
import { useCurrentThreadListItemState } from "./lib/use-current-thread-list-item.js";
import { useAdjutantAssistantRuntime } from "./runtime-hooks.js";

export default function App() {
  const runtime = useAdjutantAssistantRuntime("");

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <OpenMainThreadOnLoad />
      <TooltipProvider>
        <main className="adj-layout">
          <ThreadListSidebar />
          <section className="adj-main">
            <MainHeader />
            <Thread />
          </section>
        </main>
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

function OpenMainThreadOnLoad() {
  const aui = useAui();
  const selectedThreadRemoteId = useAuiState(
    (s) => s.threads.threadItems.find((item) => item.id === s.threads.mainThreadId)?.remoteId
  );
  const selectedThreadId = useAuiState((s) => s.threads.mainThreadId);
  const didSwitchRef = useRef(false);

  useEffect(() => {
    if (didSwitchRef.current) {
      return;
    }

    const activeThreadId = selectedThreadRemoteId ?? selectedThreadId;
    if (activeThreadId === "main") {
      didSwitchRef.current = true;
      return;
    }

    didSwitchRef.current = true;
    void aui.threads().switchToThread("main");
  }, [aui, selectedThreadId, selectedThreadRemoteId]);

  return null;
}

function MainHeader() {
  const { id: threadLocalId, remoteId: threadRemoteId, title: threadTitle } =
    useCurrentThreadListItemState();
  const rawTitle = threadTitle?.trim() ?? "";
  const threadLabel =
    rawTitle.length > 0
      ? rawTitle
      : threadRemoteId === "main" || threadLocalId === "main"
        ? "Main"
        : "Untitled";

  return (
    <header className="adj-main-header">
      <div className="adj-main-header-left">
        <span className="truncate text-sm font-medium text-foreground/80">{threadLabel}</span>
      </div>
    </header>
  );
}
