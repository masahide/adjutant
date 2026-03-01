import { AssistantRuntimeProvider, useAui } from "@assistant-ui/react";

import { TooltipProvider } from "./components/ui/tooltip.js";
import { Thread } from "./components/assistant-ui/thread.js";
import { ThreadListSidebar } from "./components/assistant-ui/thread-list.js";
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
  const aui = useAui();
  let threadLabel = "Main";
  try {
    const state = aui.threadListItem().getState() as {
      id?: string;
      remoteId?: string;
      title?: string;
    };
    const rawTitle = typeof state.title === "string" ? state.title.trim() : "";
    if (rawTitle.length > 0) {
      threadLabel = rawTitle;
    } else if (state.remoteId === "main" || state.id === "main") {
      threadLabel = "Main";
    } else {
      threadLabel = "Untitled";
    }
  } catch {
    threadLabel = "Main";
  }

  return (
    <header className="adj-main-header">
      <div className="adj-main-header-left">
        <span className="truncate text-sm font-medium text-foreground/80">{threadLabel}</span>
      </div>
    </header>
  );
}
