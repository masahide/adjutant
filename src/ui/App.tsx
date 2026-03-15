import { AssistantRuntimeProvider } from "@assistant-ui/react";

import { TooltipProvider } from "./components/ui/tooltip.js";
import { Thread } from "./components/assistant-ui/thread.js";
import { ThreadListSidebar } from "./components/assistant-ui/thread-list.js";
import { useCurrentThreadListItemState } from "./lib/use-current-thread-list-item.js";
import { useAdjutantAssistantRuntime } from "./runtime-hooks.js";

export default function App() {
  const runtime = useAdjutantAssistantRuntime("");

  return (
    <AssistantRuntimeProvider runtime={runtime}>
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
