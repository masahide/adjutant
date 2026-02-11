<script lang="ts">
  import MarkdownPreview from "$lib/components/summary/MarkdownPreview.svelte";
  import AppHeader from "$lib/components/AppHeader.svelte";
  import ThemeSwitcher from "$lib/components/ThemeSwitcher.svelte";
  import {
    formatIsoDate,
    formatIsoTimestamp,
    formatEventTime,
    formatEventTimestampJstIso,
  } from "$lib/format/date";
  import type { PageData } from "./$types";
  import type { TimelineEvent } from "$lib/server/types";
  import { writable, derived, get } from "svelte/store";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { onMount, onDestroy, tick } from "svelte";
  import { browser } from "$app/environment";
  import {
    accumulateSource,
    computeLastTimestamp,
    insertEvent,
    parseTimelineEvent,
  } from "$lib/client/timeline";
  import UpdateToast from "$lib/components/UpdateToast.svelte";
  import {
    classifyEventKind,
    getEventChannelLabel,
    getEventPresentation,
    getReactionEmoji,
    type EventPresentation,
  } from "$lib/presentation/event";
  import { resolveSlackPermalink } from "$lib/presentation/slack";
  import { buildClipboardPayload } from "$lib/presentation/clipboard";
  import { copyToClipboard } from "$lib/client/copy";
  import SummaryWorkspace from "$lib/components/summary/SummaryWorkspace.svelte";
  import {
    ensureSummaryEditUrl,
    initializeSummaryDraft,
    isSummaryEditMode,
    loadSummaryDraft,
    saveSummaryDraft,
    type SummaryDraftPayload,
  } from "$lib/client/summary/api";
  import { formatSummarySavedAt } from "$lib/summary/format";
  import { initializeLlmStore } from "$lib/stores/llm";

  export let data: PageData;

  const dateLabel = formatIsoDate(data.date);

  const events = writable([...data.events]);
  const sourcesStore = writable([...data.sources]);
  const selectedSources = writable(
    data.sources.filter((source) => source.selected).map((source) => source.name)
  );
  const filteredEvents = derived([events, selectedSources], ([all, selection]) => {
    if (selection.length === 0) {
      return all;
    }
    const allowed = new Set(selection);
    return all.filter((event) => allowed.has(event.source));
  });
  const clipboardPayload = derived(events, (all) =>
    buildClipboardPayload(data.date, all, data.summary ?? undefined, data.clipboardTemplate.source)
  );

  let lastUpdated = formatIsoTimestamp(computeLastTimestamp(data.events, data.date));

  const deliveredUids = new Set<string>(data.events.map((event) => event.uid));

  type SummaryDraftState = {
    loading: boolean;
    saving: boolean;
    content: string;
    exists: boolean;
    updatedAt?: string;
    error: string | null;
    lastSavedAt?: string | null;
    assistantMessage: string | null;
    reasoning: string | null;
  };

  const summaryDraftState = writable<SummaryDraftState>({
    loading: false,
    saving: false,
    content: data.summary ?? "",
    exists: data.summary !== null,
    updatedAt: undefined,
    error: null,
    lastSavedAt: null,
    assistantMessage: null,
    reasoning: null,
  });
  let summaryFetchPromise: Promise<void> | null = null;
  let summaryActionPending = false;
  const llmModels = data.llm.models ?? [];
  let activeModel = data.llm.defaultModel ?? llmModels[0] ?? "";
  initializeLlmStore(data.llm);
  $: summarySavedLabel = formatSummarySavedAt(
    $summaryDraftState.lastSavedAt ?? $summaryDraftState.updatedAt ?? null
  );

  const unsubscribeEvents = events.subscribe((value) => {
    lastUpdated = formatIsoTimestamp(computeLastTimestamp(value, data.date));
  });

  let eventSource: EventSource | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setInterval> | null = null;
  let fallbackActive = false;

  const toastVisible = writable(false);
  const toastMessage = writable("更新があります");

  const isSummaryEditing = derived(page, ($page) => isSummaryEditMode($page.url));

  const unsubscribeSummaryMode = isSummaryEditing.subscribe((editing) => {
    if (editing) {
      void ensureSummaryDraftLoaded();
    }
  });

  onMount(() => {
    if (!browser) {
      return;
    }
    initRealtimeStream();
  });

  let initialSync = true;
  const unsubscribeSelection = selectedSources.subscribe(async (selection) => {
    if (initialSync) {
      initialSync = false;
      return;
    }

    await tick();
    const current = get(page);
    const params = new URLSearchParams(current.url.search);

    const currentQuery = params.getAll("source").sort();
    const nextQuery = [...selection].sort();
    const isEqual =
      currentQuery.length === nextQuery.length &&
      currentQuery.every((value, index) => value === nextQuery[index]);

    if (isEqual) {
      return;
    }

    params.delete("source");
    selection.forEach((source) => params.append("source", source));

    const query = params.toString();
    await goto(`${current.url.pathname}${query ? `?${query}` : ""}`, {
      replaceState: true,
      keepFocus: true,
      noScroll: true,
    });
  });

  onDestroy(() => {
    unsubscribeSelection();
    unsubscribeEvents();
    unsubscribeSummaryMode();
    eventSource?.close();
    stopFallback();
    if (copyTimer) {
      clearTimeout(copyTimer);
    }
  });

  const toggleSource = (name: string, checked: boolean) => {
    selectedSources.update((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(name);
      } else {
        next.delete(name);
      }
      return Array.from(next);
    });
  };

  const presentationCache = new Map<string, EventPresentation>();
  let copyFeedback: "success" | "error" | null = null;
  let copyTimer: ReturnType<typeof setTimeout> | null = null;
  const slackWorkspaceBaseUrl = data.slackWorkspaceBaseUrl;

  const displayBadge = (event: TimelineEvent) => {
    const kind = classifyEventKind(event);
    if (kind === "reaction") {
      const emoji = getReactionEmoji(event);
      return emoji ? `Reaction :${emoji}:` : "Reaction";
    }
    if (kind === "post") {
      return "Post";
    }
    return event.source;
  };

  const describeEvent = (event: TimelineEvent) => getPresentation(event).text;

  const renderEventContent = (event: TimelineEvent) => getPresentation(event).html;

  function getPresentation(event: TimelineEvent): EventPresentation {
    const cached = presentationCache.get(event.uid);
    if (cached) {
      return cached;
    }
    const presentation = getEventPresentation(event);
    presentationCache.set(event.uid, presentation);
    return presentation;
  }

  const isSelected = (name: string, selection: string[]) => selection.includes(name);

  const handleCopyAll = async () => {
    if (!browser) {
      return;
    }
    const text = get(clipboardPayload);
    try {
      await copyToClipboard(text);
      setCopyFeedback("success");
    } catch (error) {
      console.error("copy failed", error);
      setCopyFeedback("error");
    }
  };

  function setCopyFeedback(value: "success" | "error" | null) {
    if (copyTimer) {
      clearTimeout(copyTimer);
      copyTimer = null;
    }
    copyFeedback = value;
    if (value) {
      copyTimer = setTimeout(() => {
        copyFeedback = null;
        copyTimer = null;
      }, 3000);
    }
  }

  function handleIncomingEvent(event: TimelineEvent) {
    if (deliveredUids.has(event.uid)) {
      presentationCache.delete(event.uid);
      return;
    }
    deliveredUids.add(event.uid);
    presentationCache.delete(event.uid);
    events.update((current) => insertEvent(current, event));
    sourcesStore.update((current) => {
      const { options, added } = accumulateSource(current, event.source);
      if (added) {
        selectedSources.update((selection) => {
          if (selection.includes(added)) {
            return selection;
          }
          return [...selection, added];
        });
      }
      return options;
    });
  }

  function initRealtimeStream() {
    eventSource?.close();
    const source = new EventSource(`/day/${data.date}/stream`);
    source.addEventListener("timeline", (event) => {
      const payload = parseTimelineEvent((event as MessageEvent<string>).data);
      if (payload) {
        handleIncomingEvent(payload);
      }
    });
    source.addEventListener("open", () => {
      stopFallback();
    });
    source.addEventListener("error", () => {
      source.close();
      startFallback();
    });
    eventSource = source;
  }

  function startFallback() {
    if (fallbackActive) {
      return;
    }
    fallbackActive = true;
    toastMessage.set("リアルタイム接続が不安定です。一定間隔で更新を確認します。");
    toastVisible.set(true);
    pollEvents();
    fallbackTimer = setInterval(pollEvents, 5000);
    reconnectTimer = setInterval(() => {
      if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
        initRealtimeStream();
      }
    }, 15000);
  }

  function stopFallback() {
    if (!fallbackActive) {
      return;
    }
    fallbackActive = false;
    if (fallbackTimer) {
      clearInterval(fallbackTimer);
      fallbackTimer = null;
    }
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }
    toastVisible.set(false);
  }

  async function pollEvents() {
    try {
      const response = await fetch(`/day/${data.date}/events`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        return;
      }
      const payload = (await response.json()) as {
        events: TimelineEvent[];
      };
      const newEvents = payload.events.filter((event) => !deliveredUids.has(event.uid));
      if (newEvents.length > 0) {
        newEvents.forEach((event) => handleIncomingEvent(event));
        toastMessage.set("新しいイベントを取り込みました。最新の表示を確認してください。");
        toastVisible.set(true);
      }
    } catch (error) {
      console.warn("fallback polling failed", error);
    }
  }

  const acknowledgeToast = () => {
    toastVisible.set(false);
  };

  const refreshFromToast = async () => {
    await pollEvents();
    toastVisible.set(false);
  };

  const slackPermalink = (event: TimelineEvent) =>
    resolveSlackPermalink(event, slackWorkspaceBaseUrl);

  async function ensureSummaryDraftLoaded(force = false): Promise<void> {
    if (!browser) {
      return;
    }
    const state = get(summaryDraftState);
    if (!force && (state.loading || summaryFetchPromise)) {
      await summaryFetchPromise;
      return;
    }
    summaryFetchPromise = (async () => {
      summaryDraftState.update((current) => ({
        ...current,
        loading: true,
        error: null,
      }));
      try {
        const payload = await loadSummaryDraft(data.date);
        applySummaryPayload(payload);
      } catch (error) {
        console.error("loadSummaryDraft failed", error);
        summaryDraftState.update((current) => ({
          ...current,
          loading: false,
          saving: false,
          error: error instanceof Error ? error.message : "サマリの取得に失敗しました",
        }));
      }
    })()
      .catch(() => {
        // errors handled above
      })
      .finally(() => {
        summaryFetchPromise = null;
      });
    await summaryFetchPromise;
  }

  async function startSummaryCreation(): Promise<void> {
    if (summaryActionPending) {
      return;
    }
    summaryActionPending = true;
    try {
      summaryDraftState.update((current) => ({
        ...current,
        loading: true,
        error: null,
      }));
      const payload = await initializeSummaryDraft(data.date);
      applySummaryPayload(payload);
      if (!get(isSummaryEditing)) {
        await navigateToSummaryEditor();
      }
    } catch (error) {
      console.error("startSummaryCreation failed", error);
      summaryDraftState.update((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "サマリの初期化に失敗しました",
      }));
    } finally {
      summaryActionPending = false;
    }
  }

  async function navigateToSummaryEditor(): Promise<void> {
    const current = get(page);
    if (!isSummaryEditMode(current.url)) {
      const target = ensureSummaryEditUrl(current.url);
      await goto(target, {
        replaceState: true,
        keepFocus: true,
        noScroll: true,
      });
      return;
    }
    await ensureSummaryDraftLoaded(true);
  }

  async function exitSummaryEditing(): Promise<void> {
    const current = get(page);
    if (!isSummaryEditMode(current.url)) {
      return;
    }
    const params = new URLSearchParams(current.url.search);
    params.delete("summary");
    const query = params.toString();
    await goto(`${current.url.pathname}${query ? `?${query}` : ""}`, {
      replaceState: true,
      keepFocus: true,
      noScroll: true,
    });
  }

  function applySummaryPayload(payload: SummaryDraftPayload): void {
    summaryDraftState.set({
      loading: false,
      saving: false,
      content: payload.content ?? "",
      exists: payload.exists,
      updatedAt: payload.updatedAt,
      error: null,
      lastSavedAt: payload.updatedAt ?? null,
      assistantMessage: payload.assistantMessage ?? null,
      reasoning: payload.reasoning ?? null,
    });
  }

  function handleWorkspaceModelChange(event: CustomEvent<{ model: string }>) {
    activeModel = event.detail.model;
  }

  function handleWorkspaceDraftInput(event: CustomEvent<{ content: string }>) {
    summaryDraftState.update((current) => ({
      ...current,
      content: event.detail.content,
    }));
  }

  function handleWorkspaceDraftSave(event: CustomEvent<{ content: string }>) {
    void saveDraft(event.detail.content);
  }

  function handleWorkspaceDraftCreate() {
    void startSummaryCreation();
  }

  function handleAssistantDismiss() {
    summaryDraftState.update((current) => ({
      ...current,
      assistantMessage: null,
      reasoning: null,
    }));
  }

  async function saveDraft(content: string): Promise<void> {
    summaryDraftState.update((current) => ({
      ...current,
      saving: true,
      error: null,
      content,
    }));
    try {
      const result = await saveSummaryDraft(data.date, { content });
      summaryDraftState.update((current) => ({
        ...current,
        saving: false,
        exists: true,
        updatedAt: result.savedAt,
        lastSavedAt: result.savedAt,
      }));
      toastMessage.set("サマリを保存しました。");
      toastVisible.set(true);
    } catch (error) {
      console.error("saveSummaryDraft failed", error);
      summaryDraftState.update((current) => ({
        ...current,
        saving: false,
        error: error instanceof Error ? error.message : "サマリの保存に失敗しました",
      }));
      toastMessage.set("サマリの保存に失敗しました。");
      toastVisible.set(true);
    }
  }
</script>

<svelte:head>
  <title>{dateLabel} のログ</title>
</svelte:head>

<main class="layout" class:layout-summary-edit={$isSummaryEditing}>
  <AppHeader>
    <svelte:fragment slot="main">
      <a class="back-link" href="/">← ダッシュボードに戻る</a>
      {#if $isSummaryEditing}
        <h1>日報サマリ {dateLabel}</h1>
        <p class="updated-at summary-saved">
          {#if summarySavedLabel}
            サマリ最終保存: {summarySavedLabel}
          {:else}
            サマリ未保存
          {/if}
        </p>
        <p class="updated-at timeline-updated">タイムライン最終記録: {lastUpdated}</p>
      {:else}
        <h1>{dateLabel} のログ</h1>
        <p class="updated-at">最終記録: {lastUpdated}</p>
      {/if}
    </svelte:fragment>
    <svelte:fragment slot="actions">
      <ThemeSwitcher selectId="timeline-theme" />
      {#if $isSummaryEditing}
        <div class="summary-actions">
          <button type="button" class="summary-exit-button" on:click={exitSummaryEditing}>
            閲覧モードに戻る
          </button>
        </div>
      {:else}
        <div class="summary-actions">
          <button
            type="button"
            class="summary-create-button"
            on:click={startSummaryCreation}
            disabled={summaryActionPending}
          >
            サマリを作成
          </button>
        </div>
      {/if}
      <div class="clipboard-controls">
        <button type="button" class="clipboard-button" on:click={handleCopyAll}>
          LLM 用にコピー
        </button>
        <a class="settings-link" href="/settings">テンプレート編集</a>
        <span
          class:custom-template={data.clipboardTemplate.origin === "custom"}
          class="template-indicator"
        >
          {data.clipboardTemplate.origin === "custom" ? "カスタム適用中" : "デフォルト使用"}
        </span>
        {#if copyFeedback === "success"}
          <span class="clipboard-status success">コピーしました</span>
        {:else if copyFeedback === "error"}
          <span class="clipboard-status error">コピーできませんでした</span>
        {/if}
      </div>
    </svelte:fragment>
  </AppHeader>

  {#if $isSummaryEditing}
    <section class="summary-edit-container">
      <SummaryWorkspace
        draft={{
          date: data.date,
          content: $summaryDraftState.content,
          updatedAt: $summaryDraftState.updatedAt,
          assistantMessage: $summaryDraftState.assistantMessage,
          reasoning: $summaryDraftState.reasoning,
        }}
        models={llmModels}
        {activeModel}
        isEditorBusy={$summaryDraftState.loading || $summaryDraftState.saving}
        lastSavedAt={$summaryDraftState.lastSavedAt ?? null}
        lastSavedLabel={summarySavedLabel}
        errorMessage={$summaryDraftState.error}
        on:modelchange={handleWorkspaceModelChange}
        on:draftinput={handleWorkspaceDraftInput}
        on:draftsave={handleWorkspaceDraftSave}
        on:draftcreate={handleWorkspaceDraftCreate}
        on:assistantdismiss={handleAssistantDismiss}
      />
      {#if $summaryDraftState.error}
        <p class="summary-error" role="alert">{$summaryDraftState.error}</p>
      {/if}
    </section>
  {:else}
    <section class="filters">
      <h2>ソースフィルタ</h2>
      {#if $sourcesStore.length === 0}
        <p class="empty">この日に取得されたイベントはありません。</p>
      {:else}
        <form method="get" class="source-form" on:submit|preventDefault>
          {#each $sourcesStore as source}
            <label class="source-option">
              <input
                type="checkbox"
                name="source"
                value={source.name}
                checked={isSelected(source.name, $selectedSources)}
                on:change={(event) => toggleSource(source.name, event.currentTarget.checked)}
              />
              <span class="name">{source.name}</span>
              <span class="count">({source.count})</span>
            </label>
          {/each}
        </form>
      {/if}
    </section>

    <section class="content">
      <div class="timeline">
        <h2>タイムライン</h2>
        {#if $filteredEvents.length === 0}
          <p class="empty">表示対象のイベントがありません。</p>
        {:else}
          <ul>
            {#each $filteredEvents as event}
              {@const permalink = slackPermalink(event)}
              <li class="timeline-item">
                <div class="time">{formatEventTime(event.loggedAt ?? event.ts, data.date)}</div>
                <div class="body">
                  <div class="meta-line">
                    <span class={`source-tag kind-${classifyEventKind(event)}`}>
                      {displayBadge(event)}
                    </span>
                    {#if getEventChannelLabel(event)}
                      <span class="channel-tag">{getEventChannelLabel(event)}</span>
                    {/if}
                    {#if event.ts}
                      <time class="timestamp original" datetime={event.ts}>
                        投稿 {formatEventTimestampJstIso(event.ts, data.date)}
                      </time>
                    {/if}
                    {#if permalink}
                      <a
                        class="timeline-permalink"
                        href={permalink}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Slackで開く
                      </a>
                    {/if}
                  </div>
                  <div class="description" aria-label={`本文: ${describeEvent(event)}`}>
                    {@html renderEventContent(event)}
                  </div>
                  <details>
                    <summary>詳細</summary>
                    <pre>{JSON.stringify(event.raw, null, 2)}</pre>
                  </details>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      {#if data.summary !== null}
        <aside class="summary">
          <h2>Markdown サマリ</h2>
          <MarkdownPreview markdown={data.summary ?? ""} debounce={0} />
        </aside>
      {/if}
    </section>
  {/if}

  <UpdateToast
    visible={$toastVisible}
    message={$toastMessage}
    on:refresh={refreshFromToast}
    on:dismiss={acknowledgeToast}
  />
</main>

<style>
  .layout {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding: 2rem;
    max-width: 1100px;
    margin: 0 auto;
    min-height: 100vh;
    box-sizing: border-box;
  }

  .back-link {
    color: var(--accent);
    font-size: 0.9rem;
    text-decoration: none;
  }

  .back-link:hover {
    text-decoration: underline;
  }

  .updated-at {
    margin-top: 0.25rem;
    font-size: 0.85rem;
    color: var(--text-secondary);
  }

  .clipboard-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .summary-actions {
    display: flex;
    align-items: center;
  }

  .summary-exit-button {
    border: 1px solid var(--surface-border-strong);
    border-radius: 999px;
    background: var(--surface-card);
    color: var(--text-primary);
    font-weight: 600;
    padding: 0.5rem 1rem;
    cursor: pointer;
  }

  .summary-exit-button:hover {
    background: var(--surface-border-muted);
  }

  .summary-create-button {
    border: none;
    border-radius: 999px;
    background: var(--accent);
    color: #fff;
    font-weight: 600;
    padding: 0.5rem 1rem;
    cursor: pointer;
  }

  .summary-create-button:disabled {
    opacity: 0.6;
    cursor: progress;
  }

  .clipboard-button {
    border: none;
    border-radius: 999px;
    background: var(--accent);
    color: #fff;
    font-size: 0.85rem;
    padding: 0.4rem 1.1rem;
    cursor: pointer;
    transition:
      background 0.2s ease,
      transform 0.2s ease;
  }

  .clipboard-button:hover {
    background: var(--accent-strong);
    transform: translateY(-1px);
  }

  .clipboard-status {
    font-size: 0.8rem;
  }

  .clipboard-status.success {
    color: #10b981;
  }

  .clipboard-status.error {
    color: #ef4444;
  }

  .settings-link {
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
  }

  .template-indicator {
    font-size: 0.78rem;
    padding: 0.25rem 0.6rem;
    border-radius: 999px;
    background: var(--button-muted-bg);
    color: var(--button-muted-text);
  }

  .template-indicator.custom-template {
    background: rgba(249, 115, 22, 0.2);
    color: #f97316;
  }

  .filters {
    border: 1px solid var(--surface-border-strong);
    border-radius: 12px;
    padding: 1rem 1.5rem;
    background: var(--surface-card);
  }

  .summary-error {
    color: #ef4444;
    font-size: 0.85rem;
    margin: 0;
  }

  .source-form {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem 1.5rem;
    align-items: center;
  }

  .source-option {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.95rem;
    color: var(--text-primary);
  }

  .source-option input {
    width: 1rem;
    height: 1rem;
  }

  .source-option .name {
    text-transform: capitalize;
  }

  .source-option .count {
    color: var(--text-secondary);
    font-size: 0.85rem;
  }

  .content {
    display: grid;
    gap: 1.5rem;
  }

  @media (min-width: 960px) {
    .content {
      grid-template-columns: 5fr 2fr;
    }
  }

  .timeline ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .timeline-item {
    display: grid;
    grid-template-columns: 80px 1fr;
    gap: 1rem;
    align-items: start;
  }

  .time {
    font-weight: 600;
    color: var(--text-secondary);
    font-size: 0.95rem;
  }

  .body {
    border: 1px solid var(--surface-border-strong);
    border-radius: 12px;
    padding: 0.9rem 1rem;
    background: var(--surface-card);
  }

  .meta-line {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-bottom: 0.5rem;
    font-size: 0.85rem;
    color: var(--text-secondary);
  }

  .timestamp {
    white-space: nowrap;
  }

  .source-tag {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    font-weight: 600;
    border: 1px solid transparent;
  }

  .kind-post {
    background: rgba(59, 130, 246, 0.15);
    color: #1d4ed8;
    border-color: rgba(59, 130, 246, 0.25);
  }

  :global([data-theme="dark"]) .kind-post {
    background: rgba(96, 165, 250, 0.2);
    color: #bfdbfe;
    border-color: rgba(96, 165, 250, 0.3);
  }

  .kind-reaction {
    background: rgba(16, 185, 129, 0.15);
    color: #047857;
    border-color: rgba(16, 185, 129, 0.25);
  }

  :global([data-theme="dark"]) .kind-reaction {
    background: rgba(52, 211, 153, 0.2);
    color: #bbf7d0;
    border-color: rgba(52, 211, 153, 0.3);
  }

  .channel-tag {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    background: rgba(148, 163, 184, 0.18);
    color: var(--text-secondary);
    font-size: 0.75rem;
    padding: 0.15rem 0.55rem;
    letter-spacing: 0.02em;
  }

  :global([data-theme="dark"]) .channel-tag {
    background: rgba(148, 163, 184, 0.22);
    color: #cbd5f5;
  }

  .timeline-permalink {
    font-size: 0.75rem;
    color: var(--accent);
    text-decoration: none;
  }

  .timeline-permalink:hover {
    text-decoration: underline;
  }

  .description {
    margin: 0.6rem 0;
    font-size: 0.95rem;
    color: var(--text-primary);
  }

  details {
    font-size: 0.85rem;
  }

  details pre {
    margin-top: 0.5rem;
    background: var(--code-block-bg);
    color: var(--code-block-text);
    padding: 0.75rem;
    border-radius: 8px;
    white-space: pre-wrap;
  }

  .summary {
    border: 1px solid var(--surface-border-strong);
    border-radius: 12px;
    padding: 1rem;
    background: var(--surface-card);
  }

  .summary :global(.markdown) {
    margin-top: 0.75rem;
  }

  .empty {
    color: var(--text-secondary);
  }

  .layout-summary-edit {
    max-width: 1600px;
    width: min(100%, 1600px);
    min-height: 100vh;
  }

  .layout-summary-edit .summary-edit-container {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }

  .layout-summary-edit .summary-error {
    margin-top: 0;
  }
</style>
