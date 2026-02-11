<script lang="ts">
  import { browser } from "$app/environment";
  import type { PageData } from "./$types";

  export let data: PageData;

  // Summary prompt templates
  let systemPromptSource = data.summaryPrompts.system.source;
  let userPromptSource = data.summaryPrompts.user.source;
  const defaultSystemPrompt = data.summaryPrompts.system.defaultSource;
  const defaultUserPrompt = data.summaryPrompts.user.defaultSource;
  let systemOrigin = data.summaryPrompts.system.origin;
  let userOrigin = data.summaryPrompts.user.origin;
  let systemPath = data.summaryPrompts.system.path;
  let userPath = data.summaryPrompts.user.path;
  let promptBaselineSystem = systemPromptSource;
  let promptBaselineUser = userPromptSource;
  let promptStatus: "idle" | "saving" | "success" | "error" | "resetting" = "idle";
  let promptError: string | null = null;

  $: isPromptDirty =
    systemPromptSource !== promptBaselineSystem || userPromptSource !== promptBaselineUser;

  // Clipboard template (existing behaviour)
  let clipboardSource = data.clipboardTemplate.source;
  let clipboardBaseline = data.clipboardTemplate.source;
  const clipboardDefault = data.clipboardTemplate.defaultSource;
  let clipboardOrigin = data.clipboardTemplate.origin;
  let clipboardPath = data.clipboardTemplate.path;
  let clipboardStatus: "idle" | "saving" | "success" | "error" | "resetting" = "idle";
  let clipboardError: string | null = null;

  $: isClipboardDirty = clipboardSource !== clipboardBaseline;

  async function savePromptTemplates() {
    if (!browser) return;
    promptStatus = "saving";
    promptError = null;
    try {
      const response = await fetch("/api/templates/summary", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemPrompt: systemPromptSource,
          userPrompt: userPromptSource,
        }),
      });
      if (!response.ok) {
        throw new Error(`保存に失敗しました (${response.status})`);
      }
      const payload = (await response.json()) as PageData["summaryPrompts"];
      systemPromptSource = payload.system.source;
      userPromptSource = payload.user.source;
      systemOrigin = payload.system.origin;
      userOrigin = payload.user.origin;
      systemPath = payload.system.path;
      userPath = payload.user.path;
      promptBaselineSystem = payload.system.source;
      promptBaselineUser = payload.user.source;
      promptStatus = "success";
    } catch (error) {
      console.error("サマリプロンプト保存エラー", error);
      promptStatus = "error";
      promptError = error instanceof Error ? error.message : "不明なエラーが発生しました";
    } finally {
      if (promptStatus === "success") {
        setTimeout(() => {
          promptStatus = "idle";
        }, 2000);
      }
    }
  }

  async function resetPromptTemplates() {
    if (!browser) return;
    promptStatus = "resetting";
    promptError = null;
    try {
      const response = await fetch("/api/templates/summary", { method: "DELETE" });
      if (!response.ok) {
        throw new Error(`リセットに失敗しました (${response.status})`);
      }
      const payload = (await response.json()) as PageData["summaryPrompts"];
      systemPromptSource = payload.system.source;
      userPromptSource = payload.user.source;
      systemOrigin = payload.system.origin;
      userOrigin = payload.user.origin;
      systemPath = payload.system.path;
      userPath = payload.user.path;
      promptBaselineSystem = payload.system.source;
      promptBaselineUser = payload.user.source;
      promptStatus = "success";
    } catch (error) {
      console.error("サマリプロンプトリセットエラー", error);
      promptStatus = "error";
      promptError = error instanceof Error ? error.message : "不明なエラーが発生しました";
    } finally {
      if (promptStatus === "success") {
        setTimeout(() => {
          promptStatus = "idle";
        }, 2000);
      }
    }
  }

  function loadPromptDefaults() {
    systemPromptSource = defaultSystemPrompt;
    userPromptSource = defaultUserPrompt;
  }

  async function saveClipboardTemplate() {
    if (!browser) return;
    clipboardStatus = "saving";
    clipboardError = null;
    try {
      const response = await fetch("/api/templates/clipboard", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: clipboardSource }),
      });
      if (!response.ok) {
        throw new Error(`保存に失敗しました (${response.status})`);
      }
      const payload = (await response.json()) as {
        source: string;
        origin: typeof clipboardOrigin;
        path: string | null;
      };
      clipboardSource = payload.source;
      clipboardBaseline = payload.source;
      clipboardOrigin = payload.origin;
      clipboardPath = payload.path;
      clipboardStatus = "success";
    } catch (error) {
      console.error("クリップボードテンプレート保存エラー", error);
      clipboardStatus = "error";
      clipboardError = error instanceof Error ? error.message : "不明なエラーが発生しました";
    } finally {
      if (clipboardStatus === "success") {
        setTimeout(() => {
          clipboardStatus = "idle";
        }, 2000);
      }
    }
  }

  async function resetClipboardTemplate() {
    if (!browser) return;
    clipboardStatus = "resetting";
    clipboardError = null;
    try {
      const response = await fetch("/api/templates/clipboard", { method: "DELETE" });
      if (!response.ok) {
        throw new Error(`リセットに失敗しました (${response.status})`);
      }
      const payload = (await response.json()) as {
        source: string;
        origin: typeof clipboardOrigin;
        path: string | null;
      };
      clipboardSource = payload.source;
      clipboardBaseline = payload.source;
      clipboardOrigin = payload.origin;
      clipboardPath = payload.path;
      clipboardStatus = "success";
    } catch (error) {
      console.error("クリップボードテンプレートリセットエラー", error);
      clipboardStatus = "error";
      clipboardError = error instanceof Error ? error.message : "不明なエラーが発生しました";
    } finally {
      if (clipboardStatus === "success") {
        setTimeout(() => {
          clipboardStatus = "idle";
        }, 2000);
      }
    }
  }

  function loadClipboardDefault() {
    clipboardSource = clipboardDefault;
  }
</script>

<svelte:head>
  <title>ReacLog 設定 - テンプレート編集</title>
</svelte:head>

<main class="page">
  <header class="header">
    <div>
      <h1>テンプレート編集</h1>
      <p class="lead">
        LLM サマリ生成に利用するプロンプトと、クリップボード出力テンプレートをここで管理します。
        保存すると config ディレクトリ配下にカスタムテンプレートが作成されます。
      </p>
    </div>
    <nav class="nav">
      <a href="/" class="nav-link">ダッシュボードへ戻る</a>
    </nav>
  </header>

  <section class="editor-section">
    <h2>サマリ生成プロンプト</h2>
    <p class="meta">
      現在の状態:
      <span
        class={systemOrigin === "custom" || userOrigin === "custom"
          ? "status custom"
          : "status default"}
      >
        {systemOrigin === "custom" || userOrigin === "custom" ? "カスタム" : "デフォルト"}
      </span>
      {#if systemPath || userPath}
        <span class="path">
          {#if systemPath}system: {systemPath}{/if}
          {#if systemPath && userPath}
            /
          {/if}
          {#if userPath}user: {userPath}{/if}
        </span>
      {/if}
    </p>
    <div class="controls">
      <button type="button" class="button secondary" on:click={loadPromptDefaults}>
        デフォルトを読み込む
      </button>
      <div class="spacer" />
      <button
        type="button"
        class="button danger"
        on:click={resetPromptTemplates}
        disabled={promptStatus === "saving" || promptStatus === "resetting"}
      >
        デフォルトに戻す
      </button>
      <button
        type="button"
        class="button primary"
        on:click={savePromptTemplates}
        disabled={!isPromptDirty || promptStatus === "saving" || promptStatus === "resetting"}
      >
        {#if promptStatus === "saving"}
          保存中…
        {:else}
          保存する
        {/if}
      </button>
    </div>
    <div class="prompt-editors">
      <label class="prompt-label">
        <span>システムプロンプト（instructions）</span>
        <textarea
          bind:value={systemPromptSource}
          spellcheck="false"
          class="editor"
          aria-label="System prompt template source"
        />
      </label>
      <label class="prompt-label">
        <span>ユーザープロンプト（input）</span>
        <textarea
          bind:value={userPromptSource}
          spellcheck="false"
          class="editor"
          aria-label="User prompt template source"
        />
      </label>
    </div>
    {#if promptStatus === "success"}
      <p class="feedback success">保存しました。</p>
    {:else if promptStatus === "error"}
      <p class="feedback error">{promptError ?? "保存に失敗しました。"}</p>
    {/if}
  </section>

  <section class="editor-section">
    <h2>クリップボードテンプレート</h2>
    <p class="meta">
      現在の状態:
      <span class={clipboardOrigin === "custom" ? "status custom" : "status default"}>
        {clipboardOrigin === "custom" ? "カスタム" : "デフォルト"}
      </span>
      {#if clipboardPath}
        <span class="path">({clipboardPath})</span>
      {/if}
    </p>
    <div class="controls">
      <button type="button" class="button secondary" on:click={loadClipboardDefault}>
        デフォルトを読み込む
      </button>
      <div class="spacer" />
      <button
        type="button"
        class="button danger"
        on:click={resetClipboardTemplate}
        disabled={clipboardStatus === "saving" || clipboardStatus === "resetting"}
      >
        デフォルトに戻す
      </button>
      <button
        type="button"
        class="button primary"
        on:click={saveClipboardTemplate}
        disabled={!isClipboardDirty ||
          clipboardStatus === "saving" ||
          clipboardStatus === "resetting"}
      >
        {#if clipboardStatus === "saving"}
          保存中…
        {:else}
          保存する
        {/if}
      </button>
    </div>
    <textarea
      bind:value={clipboardSource}
      spellcheck="false"
      class="editor"
      aria-label="Clipboard template source"
    />
    {#if clipboardStatus === "success"}
      <p class="feedback success">保存しました。</p>
    {:else if clipboardStatus === "error"}
      <p class="feedback error">{clipboardError ?? "保存に失敗しました。"}</p>
    {/if}
  </section>
</main>

<style>
  .page {
    max-width: 960px;
    margin: 0 auto;
    padding: 2rem;
    display: flex;
    flex-direction: column;
    gap: 2.5rem;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1.5rem;
    flex-wrap: wrap;
  }

  .lead {
    margin: 0.75rem 0 0;
    color: var(--text-secondary);
    line-height: 1.6;
  }

  .nav-link {
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
  }

  .editor-section {
    border: 1px solid var(--surface-border-strong);
    border-radius: 12px;
    padding: 1.5rem;
    background: var(--surface-card);
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .spacer {
    flex: 1;
  }

  .button {
    border: none;
    border-radius: 999px;
    padding: 0.4rem 1.1rem;
    font-weight: 600;
    cursor: pointer;
    font-size: 0.9rem;
  }

  .button.primary {
    background: var(--accent);
    color: #fff;
  }

  .button.secondary {
    background: var(--button-muted-bg);
    color: var(--button-muted-text);
  }

  .button.danger {
    background: rgba(239, 68, 68, 0.15);
    color: #b91c1c;
  }

  .button:disabled {
    opacity: 0.6;
    cursor: progress;
  }

  .prompt-editors {
    display: grid;
    gap: 1rem;
  }

  @media (min-width: 720px) {
    .prompt-editors {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .prompt-label {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .editor {
    min-height: 12rem;
    font-family: var(--font-mono, ui-monospace);
    font-size: 0.9rem;
    padding: 0.75rem;
    border-radius: 0.5rem;
    border: 1px solid var(--surface-border-strong);
    background: var(--surface-body);
    color: inherit;
    resize: vertical;
  }

  .meta {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.9rem;
  }

  .status {
    font-weight: 600;
  }

  .status.default {
    color: var(--accent);
  }

  .status.custom {
    color: #f97316;
  }

  .path {
    margin-left: 0.5rem;
    font-family: var(--font-mono, ui-monospace);
    font-size: 0.8rem;
  }

  .feedback {
    font-size: 0.85rem;
    margin: 0;
  }

  .feedback.success {
    color: #10b981;
  }

  .feedback.error {
    color: #ef4444;
  }
</style>
