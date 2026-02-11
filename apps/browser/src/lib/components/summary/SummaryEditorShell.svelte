<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { useDebouncedWritable } from "$lib/hooks/useDebouncedWritable";
  import type { SummaryEditorDraft } from "./types";

  export let draft: SummaryEditorDraft;
  export let isBusy = false;

  const dispatch = createEventDispatcher<{
    create: { date: string };
    input: { content: string };
    save: { content: string };
  }>();

  let value = draft?.content ?? "";
  let draftSignature = signature(draft);
  let textareaId = createTextareaId(draft);
  let textarea: HTMLTextAreaElement | null = null;
  const debouncedInput = useDebouncedWritable(value, {
    delay: 500,
    onFlush: (content) => {
      dispatch("input", { content });
    },
  });

  $: {
    const nextSignature = signature(draft);
    if (nextSignature !== draftSignature) {
      draftSignature = nextSignature;
      value = draft?.content ?? "";
      textareaId = createTextareaId(draft);
      debouncedInput.set(value);
    }
  }

  function handleCreate() {
    dispatch("create", { date: draft?.date ?? "" });
  }

  function handleInput(event: Event) {
    const target = event.currentTarget as HTMLTextAreaElement;
    value = target.value;
    debouncedInput.set(value);
  }

  function handleSave() {
    debouncedInput.flush();
    dispatch("save", { content: value });
  }

  function handleKeydown(event: KeyboardEvent) {
    const isMetaSave = (event.metaKey || event.ctrlKey) && (event.key === "s" || event.key === "S");
    const isMetaSubmit =
      (event.metaKey || event.ctrlKey) && (event.key === "Enter" || event.code === "Enter");
    if (isMetaSave || isMetaSubmit) {
      event.preventDefault();
      handleSave();
    }
  }

  function signature(input: SummaryEditorDraft | undefined): string {
    if (!input) {
      return "";
    }
    return `${input.date ?? ""}::${input.updatedAt ?? ""}::${input.content ?? ""}`;
  }

  function createTextareaId(input: SummaryEditorDraft | undefined): string {
    const suffix = input?.date ? input.date.replace(/[^a-z0-9_-]/gi, "-") : "unknown";
    return `summary-editor-body-${suffix}`;
  }

  export function getSelection(): { start: number; end: number; content: string } {
    if (!textarea) {
      return { start: 0, end: 0, content: "" };
    }
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const actualStart = Math.min(start, end);
    const actualEnd = Math.max(start, end);
    return {
      start: Math.max(actualStart, 0),
      end: Math.max(actualEnd, 0),
      content: textarea.value.slice(Math.max(actualStart, 0), Math.max(actualEnd, 0)),
    };
  }

  export function getTextarea(): HTMLTextAreaElement | null {
    return textarea;
  }
</script>

<div class="summary-editor-shell" data-testid="summary-editor-shell">
  <header class="shell-header">
    <h2 class="shell-title">サマリ編集</h2>
    <div class="shell-actions">
      <button type="button" on:click={handleCreate} disabled={isBusy}> サマリを作成 </button>
      <button type="button" on:click={handleSave} disabled={isBusy}> 保存 </button>
    </div>
  </header>

  <section class="shell-body">
    <label class="textarea-label">
      <span class="textarea-caption" id={`${textareaId}-label`}>サマリ本文</span>
      <textarea
        class="summary-input"
        id={textareaId}
        aria-labelledby={`${textareaId}-label`}
        bind:value
        bind:this={textarea}
        on:input={handleInput}
        on:keydown={handleKeydown}
        spellcheck="false"
        rows="12"
      />
    </label>
  </section>
</div>

<style>
  .summary-editor-shell {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    flex: 1 1 auto;
    min-height: 0;
  }

  .shell-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .shell-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .shell-body {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    flex: 1 1 auto;
    min-height: 0;
  }

  .textarea-label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    flex: 1 1 auto;
    min-height: 0;
  }

  .summary-input {
    flex: 1 1 auto;
    min-height: 0;
    height: 100%;
    font-family: var(--font-mono, ui-monospace);
    font-size: 0.95rem;
    padding: 0.75rem;
    border-radius: 0.5rem;
    border: 1px solid var(--border-color, #cbd5e1);
    resize: none;
    box-sizing: border-box;
    overflow: auto;
  }
</style>
