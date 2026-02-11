<script lang="ts">
  import { formatIsoDate } from "$lib/format/date";
  import type { PageData } from "./$types";

  export let data: PageData;

  const dateLabel = formatIsoDate(data.date);
</script>

<svelte:head>
  <title>{dateLabel} の生データ</title>
</svelte:head>

<main class="layout">
  <header class="header">
    <div>
      <a class="back-link" href={`/day/${data.date}`}>← タイムラインに戻る</a>
      <h1>{dateLabel} の生 JSONL</h1>
    </div>
  </header>

  {#if data.files.length === 0}
    <p class="empty">表示できるデータがありません。</p>
  {:else}
    <section class="raw-grid">
      {#each data.files as file}
        <article class="raw-card">
          <header>
            <h2>{file.source}</h2>
            <span class="line-count">{file.lines.length} 行</span>
          </header>
          <pre>{file.lines.join("\n")}</pre>
        </article>
      {/each}
    </section>
  {/if}
</main>

<style>
  .layout {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding: 2rem;
    max-width: 1100px;
    margin: 0 auto;
  }

  .header h1 {
    margin-top: 0.75rem;
  }

  .back-link {
    color: #2563eb;
    font-size: 0.9rem;
    text-decoration: none;
  }

  .back-link:hover {
    text-decoration: underline;
  }

  .empty {
    color: #777;
  }

  .raw-grid {
    display: grid;
    gap: 1.5rem;
  }

  @media (min-width: 960px) {
    .raw-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .raw-card {
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    background: #0f172a;
    color: #f8fafc;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .raw-card header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }

  .line-count {
    font-size: 0.85rem;
    opacity: 0.7;
  }

  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.85rem;
  }
</style>
