import { AssistantRuntimeProvider } from "@assistant-ui/react";

import { Thread } from "./components/assistant-ui/thread.js";
import { ThreadListSidebar } from "./components/assistant-ui/thread-list.js";
import { useAdjutantAssistantRuntime } from "./runtime-hooks.js";

export default function App() {
  const runtime = useAdjutantAssistantRuntime("");

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <main className="adj-layout">
        <ThreadListSidebar />
        <section className="adj-main">
          <header className="adj-main-header">Adjutant Assistant UI</header>
          <Thread />
        </section>
      </main>
    </AssistantRuntimeProvider>
  );
}
