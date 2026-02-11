<script lang="ts">
  import { afterUpdate, createEventDispatcher, onDestroy } from "svelte";
  import SummaryEditorShell from "$lib/components/summary/SummaryEditorShell.svelte";
  import MarkdownPreview from "$lib/components/summary/MarkdownPreview.svelte";
  import { requestSuggestion, type SummaryChatSelection } from "$lib/client/summary/chat";
  import { diffSummary, type SummaryDiffLine } from "$lib/summary/diff";
  import { applySummaryUpdate } from "$lib/summary/update";
  import { synchronizeByRatio } from "$lib/scroll/sync";
  import type {
    SummaryEditorDraft,
    SummarySuggestionPayload,
    SummaryUpdate,
    SummaryWorkspaceEvents,
  } from "./types";

  export let draft: SummaryEditorDraft;
  export let models: string[] = [];
  export let activeModel: string | null = null;
  export let isChatBusy = false;
  export let isEditorBusy = false;
  export let lastSavedAt: string | null = null;
  export let lastSavedLabel: string | null = null;
  export let errorMessage: string | null = null;

  const dispatch = createEventDispatcher<SummaryWorkspaceEvents>();

  type SelectionSnapshot = {
    start: number;
    end: number;
    content: string;
  };

  type SuggestionEntry = {
    id: number;
    payload: SummarySuggestionPayload;
    diff: SummaryDiffLine[];
    selection: SelectionSnapshot | null;
    baseContent: string;
    applied: boolean;
    dismissed: boolean;
  };

  type ChatEntry =
    | { id: number; kind: "user"; prompt: string }
    | { id: number; kind: "assistant"; suggestionId: number };

  type ChatTimelineEntry =
    | { id: number; kind: "user"; prompt: string }
    | { id: number; kind: "assistant"; suggestionId: number; suggestion: SuggestionEntry };

  let prompt = "";
  let selectedModel = activeModel ?? models[0] ?? "";
  let draftSignature = signature(draft);
  let draftSessionKey = sessionKey(draft);
  let editorDraft: SummaryEditorDraft = { ...draft };
  let suggestions: SuggestionEntry[] = [];
  let localChatBusy = false;
  let suggestionSeq = 0;
  let lastResponseId: string | null = null;
  let initialAssistantMessage: string | null = draft.assistantMessage ?? null;
  let initialAssistantReasoning: string | null = draft.reasoning ?? null;
  let pendingDraftContent: string | null = null;
  let chatEntries: ChatEntry[] = [];
  let chatEntrySeq = 0;

  let editorRef: SummaryEditorShell | null = null;
  let previewRef: MarkdownPreview | null = null;
  let editorElement: HTMLTextAreaElement | null = null;
  let previewElement: HTMLElement | null = null;
  let chatBodyElement: HTMLDivElement | null = null;
  let disposeScrollSync: (() => void) | null = null;
  let scrollSyncing = false;
  let suggestionById = new Map<number, SuggestionEntry>();
  let previousChatEntryCount = 0;
  let chatTimeline: ChatTimelineEntry[] = [];

  $: {
    if (activeModel && activeModel !== selectedModel) {
      selectedModel = activeModel;
    } else if (!activeModel && selectedModel === "" && models.length > 0) {
      selectedModel = models[0];
    }
  }

  $: {
    const nextSignature = signature(draft);
    if (nextSignature !== draftSignature) {
      const normalizedDraftContent = draft.content ?? "";
      const isInternalUpdate =
        pendingDraftContent !== null && pendingDraftContent === normalizedDraftContent;
      const nextSessionKey = sessionKey(draft);
      const sessionChanged = nextSessionKey !== draftSessionKey;
      draftSignature = nextSignature;
      draftSessionKey = nextSessionKey;
      editorDraft = { ...draft };
      if (!isInternalUpdate) {
        initialAssistantMessage = draft.assistantMessage ?? null;
        initialAssistantReasoning = draft.reasoning ?? null;
        if (sessionChanged) {
          lastResponseId = null;
          suggestions = [];
          suggestionSeq = 0;
          chatEntries = [];
          chatEntrySeq = 0;
        }
      }
      pendingDraftContent = null;
    }
  }

  $: suggestionById = new Map(suggestions.map((item) => [item.id, item]));
  $: chatTimeline = chatEntries
    .map((entry): ChatTimelineEntry | null => {
      if (entry.kind === "assistant") {
        const suggestion = suggestionById.get(entry.suggestionId);
        if (!suggestion) {
          return null;
        }
        return { ...entry, suggestion };
      }
      return entry;
    })
    .filter((entry): entry is ChatTimelineEntry => entry !== null);

  $: {
    const nextEditor = editorRef?.getTextarea?.() ?? null;
    if (nextEditor !== editorElement) {
      editorElement = nextEditor;
      refreshScrollSync();
    }
  }

  onDestroy(() => {
    disposeScrollSync?.();
  });

  afterUpdate(() => {
    const nextPreview = previewRef?.getScrollableElement?.() ?? null;
    if (nextPreview !== previewElement) {
      previewElement = nextPreview;
      refreshScrollSync();
    }
    if (chatBodyElement && chatEntries.length > previousChatEntryCount) {
      chatBodyElement.scrollTop = chatBodyElement.scrollHeight;
    }
    previousChatEntryCount = chatEntries.length;
  });

  function refreshScrollSync() {
    disposeScrollSync?.();
    disposeScrollSync = null;
    if (!editorElement || !previewElement) {
      return;
    }
    const editor = editorElement;
    const preview = previewElement;
    const handleEditor = () => synchronizeScroll("editor");
    const handlePreview = () => synchronizeScroll("preview");
    editor.addEventListener("scroll", handleEditor);
    preview.addEventListener("scroll", handlePreview);
    disposeScrollSync = () => {
      editor.removeEventListener("scroll", handleEditor);
      preview.removeEventListener("scroll", handlePreview);
    };
  }

  function synchronizeScroll(origin: "editor" | "preview") {
    if (!editorElement || !previewElement || scrollSyncing) {
      return;
    }
    const source = origin === "editor" ? editorElement : previewElement;
    const target = origin === "editor" ? previewElement : editorElement;
    scrollSyncing = true;
    synchronizeByRatio(source, target);
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        scrollSyncing = false;
      });
    } else {
      scrollSyncing = false;
    }
  }

  const chatBusy = () => isChatBusy || localChatBusy;

  const currentModel = () => selectedModel || models[0] || "";

  async function handlePromptSubmit() {
    const model = currentModel();
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || !model || chatBusy()) {
      return;
    }
    const selection = captureSelection();
    const selectionPayload: SummaryChatSelection | undefined = selection
      ? {
          start: selection.start,
          end: selection.end,
          content: selection.content,
        }
      : undefined;
    const baseContent = editorDraft.content;
    chatEntrySeq += 1;
    chatEntries = [...chatEntries, { id: chatEntrySeq, kind: "user", prompt: trimmedPrompt }];
    localChatBusy = true;
    try {
      const response = await requestSuggestion({
        model,
        prompt: trimmedPrompt,
        content: baseContent,
        date: editorDraft.date ?? draft.date ?? "",
        previousResponseId: lastResponseId ?? undefined,
        selection: selectionPayload,
      });
      suggestionSeq += 1;
      const suggestionId = suggestionSeq;
      suggestions = [
        ...suggestions,
        {
          id: suggestionId,
          payload: response,
          diff: diffSummary(baseContent, applySummaryUpdate(baseContent, response.summaryUpdate)),
          selection,
          baseContent,
          applied: false,
          dismissed: false,
        },
      ];
      chatEntrySeq += 1;
      chatEntries = [...chatEntries, { id: chatEntrySeq, kind: "assistant", suggestionId }];
      if (response.responseId) {
        lastResponseId = response.responseId;
      }
      dispatch("promptsubmit", { prompt: trimmedPrompt, model });
      prompt = "";
    } catch (error) {
      console.error("requestSuggestion failed", error);
    } finally {
      localChatBusy = false;
    }
  }

  function captureSelection(): SelectionSnapshot | null {
    const handle = editorRef;
    if (!handle || typeof handle.getSelection !== "function") {
      return null;
    }
    const snapshot = handle.getSelection();
    if (!snapshot || snapshot.end <= snapshot.start) {
      return null;
    }
    return snapshot;
  }

  function handleModelChange(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    const nextModel = select.value;
    selectedModel = nextModel;
    dispatch("modelchange", { model: nextModel });
  }

  function handleDraftInput(event: CustomEvent<{ content: string }>) {
    editorDraft = { ...editorDraft, content: event.detail.content };
    pendingDraftContent = event.detail.content;
    dispatch("draftinput", event.detail);
  }

  function handleDraftSave(event: CustomEvent<{ content: string }>) {
    editorDraft = { ...editorDraft, content: event.detail.content };
    dispatch("draftsave", event.detail);
  }

  function handlePreviewReady(event: CustomEvent<{ element: HTMLElement | null }>) {
    const nextPreview = event.detail.element ?? null;
    if (nextPreview !== previewElement) {
      previewElement = nextPreview;
      refreshScrollSync();
    }
  }

  function handleDraftCreate(event: CustomEvent<{ date: string }>) {
    dispatch("draftcreate", event.detail);
  }

  function applySuggestion(suggestion: SuggestionEntry, mode: SummaryUpdate["mode"]) {
    if (!hasSuggestionContent(suggestion.payload.summaryUpdate)) {
      return;
    }
    const nextContent = sanitizeContentWithAssistantMessage(
      applySummaryUpdate(editorDraft.content, suggestion.payload.summaryUpdate, mode),
      suggestion.payload.assistantMessage
    );
    updateEditorDraft(nextContent);
    suggestions = suggestions.map((item) =>
      item.id === suggestion.id ? { ...item, applied: true, dismissed: false } : item
    );
  }

  function sanitizeContentWithAssistantMessage(content: string, assistantMessage: string | null) {
    if (!assistantMessage) {
      return content;
    }
    const trimmedAssistant = assistantMessage.trim();
    if (!trimmedAssistant) {
      return content;
    }
    const trimmedContent = content.trimEnd();
    if (trimmedContent === trimmedAssistant) {
      return "";
    }
    if (trimmedContent.endsWith(`\n${trimmedAssistant}`)) {
      const withoutMessage = trimmedContent.slice(
        0,
        trimmedContent.length - trimmedAssistant.length
      );
      return withoutMessage.trimEnd();
    }
    return content;
  }

  function dismissSuggestion(id: number) {
    suggestions = suggestions.map((item) =>
      item.id === id ? { ...item, dismissed: true, applied: false } : item
    );
  }

  function restoreSuggestion(id: number) {
    suggestions = suggestions.map((item) =>
      item.id === id ? { ...item, dismissed: false } : item
    );
  }

  function updateEditorDraft(content: string) {
    editorDraft = { ...editorDraft, content };
    pendingDraftContent = content;
    dispatch("draftinput", { content });
  }

  function hasSuggestionContent(update: SummaryUpdate): boolean {
    return update.mode !== "none" && update.content.trim().length > 0;
  }

  function formatDiffLine(line: SummaryDiffLine): string {
    const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
    return `${prefix}${line.value}`;
  }

  function summarizeSelection(selection: SelectionSnapshot | null): string | null {
    if (!selection) {
      return null;
    }
    const trimmed = selection.content.trim();
    if (!trimmed) {
      return "(空白)";
    }
    return trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 77)}…`;
  }

  function signature(input: SummaryEditorDraft): string {
    return `${input.date ?? ""}::${input.updatedAt ?? ""}::${input.content ?? ""}::${input.assistantMessage ?? ""}::${input.reasoning ?? ""}`;
  }

  function sessionKey(input: SummaryEditorDraft): string {
    return `${input.date ?? ""}::${input.updatedAt ?? ""}`;
  }
</script>

<div class="summary-workspace">
  <section class="pane chat" aria-label="LLM チャット">
    <header class="pane-header">
      <h2>LLM チャット</h2>
      <label class="model-selector">
        <span>モデル</span>
        <select
          aria-label="LLM モデル"
          on:change={handleModelChange}
          disabled={models.length === 0 || chatBusy()}
          bind:value={selectedModel}
        >
          {#each models as model}
            <option value={model}>{model}</option>
          {/each}
        </select>
      </label>
    </header>
    <div class="chat-body" bind:this={chatBodyElement}>
      {#if initialAssistantMessage}
        <section class="initial-assistant-message">
          <h3>生成したサマリへのコメント</h3>
          <p class="assistant-message">{initialAssistantMessage}</p>
          {#if initialAssistantReasoning}
            <p class="assistant-reasoning">{initialAssistantReasoning}</p>
          {/if}
          <button
            type="button"
            class="initial-dismiss"
            on:click={() => {
              initialAssistantMessage = null;
              initialAssistantReasoning = null;
              dispatch("assistantdismiss", {});
            }}
          >
            非表示にする
          </button>
        </section>
      {/if}

      {#if chatTimeline.length > 0}
        <ul class="chat-log">
          {#each chatTimeline as entry (entry.id)}
            {#if entry.kind === "user"}
              <li class="chat-entry user">
                <span class="chat-user-label">あなた</span>
                <p class="chat-user-message" aria-label={entry.prompt}>
                  {`\u200B${entry.prompt}`}
                </p>
              </li>
            {:else if entry.kind === "assistant"}
              <li class="chat-entry assistant">
                <article class="suggestion-card">
                  <header class="suggestion-header">
                    <p class="assistant-message">{entry.suggestion.payload.assistantMessage}</p>
                  </header>
                  {#if summarizeSelection(entry.suggestion.selection)}
                    <p class="assistant-selection">
                      選択範囲: {summarizeSelection(entry.suggestion.selection)}
                    </p>
                  {/if}
                  {#if entry.suggestion.diff.length > 0}
                    <pre class="diff-lines">
                      {#each entry.suggestion.diff as line, index (index)}
                        <code class={`diff-line ${line.type}`}>{formatDiffLine(line)}</code>
                      {/each}
                    </pre>
                  {:else if hasSuggestionContent(entry.suggestion.payload.summaryUpdate)}
                    <pre class="raw-suggestion">
                      {entry.suggestion.payload.summaryUpdate.content}
                    </pre>
                  {/if}
                  {#if entry.suggestion.payload.reasoning}
                    <p class="assistant-reasoning">{entry.suggestion.payload.reasoning}</p>
                  {/if}
                  <div class="suggestion-actions">
                    {#if entry.suggestion.applied}
                      <span class="suggestion-status applied">適用済み</span>
                    {:else if entry.suggestion.dismissed}
                      <span class="suggestion-status cancelled">キャンセル済み</span>
                      <button
                        type="button"
                        class="secondary"
                        on:click={() => restoreSuggestion(entry.suggestion.id)}
                      >
                        再表示
                      </button>
                    {:else}
                      <button
                        type="button"
                        on:click={() => applySuggestion(entry.suggestion, "replace")}
                        disabled={!hasSuggestionContent(entry.suggestion.payload.summaryUpdate) ||
                          chatBusy()}
                      >
                        置き換え
                      </button>
                      <button
                        type="button"
                        on:click={() => applySuggestion(entry.suggestion, "append")}
                        disabled={!hasSuggestionContent(entry.suggestion.payload.summaryUpdate) ||
                          chatBusy()}
                      >
                        追記
                      </button>
                      <button
                        type="button"
                        class="secondary"
                        on:click={() => dismissSuggestion(entry.suggestion.id)}
                      >
                        キャンセル
                      </button>
                    {/if}
                  </div>
                </article>
              </li>
            {/if}
          {/each}
        </ul>
      {/if}
    </div>

    <div class="chat-input">
      <textarea
        class="prompt-input"
        placeholder="LLM への指示を書きます"
        rows="2"
        bind:value={prompt}
        disabled={chatBusy()}
      />
      <button
        class="prompt-submit"
        type="button"
        on:click={handlePromptSubmit}
        disabled={chatBusy()}
      >
        送信
      </button>
    </div>
  </section>

  <section class="pane editor" aria-label="Markdown 編集">
    <SummaryEditorShell
      bind:this={editorRef}
      isBusy={isEditorBusy}
      draft={editorDraft}
      on:create={handleDraftCreate}
      on:input={handleDraftInput}
      on:save={handleDraftSave}
    />
    <div class="status-list">
      {#if lastSavedLabel}
        <p class="status saved-at">最終保存: {lastSavedLabel}</p>
      {:else if lastSavedAt}
        <p class="status saved-at">最終保存: {lastSavedAt}</p>
      {/if}
      {#if errorMessage}
        <p class="status error" role="alert">{errorMessage}</p>
      {/if}
    </div>
  </section>

  <section class="pane preview" aria-label="Markdown プレビュー">
    <header class="pane-header">
      <h2>Markdown プレビュー</h2>
    </header>
    <div class="preview-body">
      <MarkdownPreview
        bind:this={previewRef}
        markdown={editorDraft.content}
        debounce={300}
        on:ready={handlePreviewReady}
      />
    </div>
  </section>
</div>

<style>
  .summary-workspace {
    display: flex;
    gap: 1.5rem;
    width: 100%;
    align-items: stretch;
    flex: 1 1 0;
    min-height: 0;
    height: 100%;
    overflow: hidden;
  }

  .summary-workspace .pane {
    flex: 1 1 0;
    min-width: 0;
    background: var(--surface-card);
    border: 1px solid var(--surface-border-strong);
    border-radius: 12px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-height: 0;
    overflow: hidden;
  }

  .summary-workspace .pane.chat {
    flex: 0.95 1 0;
    min-height: 0;
  }

  .summary-workspace .chat-body {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    overflow-y: auto;
    min-height: 0;
  }

  .summary-workspace .chat-input {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .summary-workspace .pane.editor {
    flex: 1.15 1 0;
  }

  .summary-workspace .pane.preview {
    flex: 1.1 1 0;
    max-width: 600px;
    min-height: 0;
  }

  @media (max-width: 1400px) {
    .summary-workspace {
      gap: 1.25rem;
    }
  }

  @media (max-width: 1120px) {
    .summary-workspace {
      flex-wrap: wrap;
    }

    .summary-workspace .pane.preview {
      flex: 1 1 100%;
      max-width: none;
    }
  }

  @media (max-width: 880px) {
    .summary-workspace {
      flex-direction: column;
      gap: 1rem;
    }

    .summary-workspace .pane.preview {
      flex: 1 1 auto;
    }
  }

  .summary-workspace .pane-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .summary-workspace .pane-header h2 {
    margin: 0;
    font-size: 1rem;
  }

  .summary-workspace .model-selector {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
  }

  .summary-workspace .model-selector select {
    padding: 0.35rem 0.5rem;
    border-radius: 0.5rem;
    border: 1px solid var(--surface-border-strong);
  }

  .summary-workspace .prompt-input {
    min-height: 3.8rem;
    height: 3.8rem;
    resize: vertical;
    font-family: inherit;
    font-size: 0.95rem;
    padding: 0.85rem;
    border-radius: 0.75rem;
    border: 1px solid var(--surface-border);
    line-height: 1.4;
    width: 100%;
    box-sizing: border-box;
  }

  .summary-workspace .initial-assistant-message {
    margin-top: 0.75rem;
    padding: 0.75rem;
    border-radius: 0.75rem;
    background: rgba(37, 99, 235, 0.08);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .summary-workspace .initial-assistant-message h3 {
    margin: 0;
    font-size: 0.9rem;
    color: var(--text-secondary);
  }

  .summary-workspace .initial-assistant-message .assistant-reasoning {
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .summary-workspace .initial-assistant-message .initial-dismiss {
    align-self: flex-end;
    border: none;
    background: transparent;
    color: var(--accent);
    font-size: 0.8rem;
    cursor: pointer;
    padding: 0;
  }

  .summary-workspace .initial-assistant-message .initial-dismiss:hover {
    text-decoration: underline;
  }

  .summary-workspace .prompt-submit {
    align-self: flex-end;
    border: none;
    border-radius: 999px;
    background: var(--accent);
    color: #fff;
    font-weight: 600;
    padding: 0.45rem 1.2rem;
    cursor: pointer;
  }

  .summary-workspace .prompt-submit:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .summary-workspace .chat-log {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .summary-workspace .chat-entry {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .summary-workspace .chat-entry.user {
    align-items: flex-end;
  }

  .summary-workspace .chat-user-label {
    font-size: 0.75rem;
    color: var(--text-tertiary);
  }

  .summary-workspace .chat-user-message {
    margin: 0;
    max-width: 100%;
    padding: 0.6rem 0.9rem;
    border-radius: 1rem;
    background: var(--accent);
    color: #fff;
    font-size: 0.9rem;
    white-space: pre-wrap;
  }

  .summary-workspace .chat-entry.assistant {
    align-items: stretch;
  }

  .summary-workspace .suggestion-card {
    border: 1px solid var(--surface-border);
    border-radius: 0.75rem;
    padding: 0.75rem;
    background: var(--surface-base);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .summary-workspace .suggestion-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .summary-workspace .suggestion-actions button {
    border: none;
    border-radius: 999px;
    background: var(--accent);
    color: #fff;
    font-size: 0.8rem;
    padding: 0.3rem 0.9rem;
    cursor: pointer;
  }

  .summary-workspace .suggestion-actions button.secondary {
    background: var(--surface-border-strong);
    color: var(--text-secondary);
  }

  .summary-workspace .suggestion-actions button:hover {
    opacity: 0.9;
  }

  .summary-workspace .suggestion-status {
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .summary-workspace .suggestion-status.applied {
    font-weight: 600;
  }

  .summary-workspace .suggestion-status.cancelled {
    color: var(--text-tertiary);
    font-style: italic;
  }

  .summary-workspace .status-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .summary-workspace .status {
    margin: 0;
    font-size: 0.8rem;
  }

  .summary-workspace .status.saved-at {
    color: var(--text-secondary);
  }

  .summary-workspace .status.error {
    color: #ef4444;
  }

  .summary-workspace .preview-body {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    overflow: auto;
    min-height: 0;
    height: 100%;
  }

  .summary-workspace .suggestion-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .summary-workspace .assistant-message {
    margin: 0;
    font-weight: 600;
    font-size: 0.9rem;
  }

  .summary-workspace .assistant-selection {
    margin: 0;
    font-size: 0.8rem;
    color: var(--text-tertiary);
  }

  .summary-workspace .assistant-reasoning {
    margin: 0;
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .summary-workspace .diff-lines {
    margin: 0;
    padding: 0.5rem;
    border-radius: 0.5rem;
    background: var(--code-block-bg);
    font-family: var(--font-mono, ui-monospace);
    font-size: 0.8rem;
    line-height: 1.3;
    overflow-x: auto;
  }

  .summary-workspace .diff-line {
    display: block;
    white-space: pre;
  }

  .summary-workspace .diff-line.add {
    color: #15803d;
  }

  .summary-workspace .diff-line.remove {
    color: #dc2626;
  }

  .summary-workspace .diff-line.context {
    color: var(--text-secondary);
  }

  .summary-workspace .raw-suggestion {
    margin: 0;
    white-space: pre-wrap;
    font-family: inherit;
    font-size: 0.85rem;
    color: var(--text-primary);
    background: var(--surface-muted);
    padding: 0.5rem;
    border-radius: 0.5rem;
  }
</style>
