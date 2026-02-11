<script lang="ts">
  import { formatIsoDate } from "$lib/format/date";
  import type { DashboardDay } from "$lib/viewModels/dashboard";

  export let day: DashboardDay;
</script>

<article class="card">
  <header>
    <h3>{formatIsoDate(day.date)}</h3>
    <p class="total"><strong>{day.total}</strong> 件</p>
  </header>

  <ul class="sources">
    {#each day.sources as source}
      <li>
        <span class="source-name">{source.source}</span>
        <span class="source-count">{source.count}</span>
      </li>
    {/each}
  </ul>

  {#if day.hasSummary && day.summaryPreview}
    <pre class="summary">{day.summaryPreview}</pre>
  {:else}
    <p class="no-summary">サマリ未作成</p>
  {/if}

  <a class="detail-link" href={`/day/${day.date}`}>詳細を見る</a>
</article>

<style>
  .card {
    padding: 1.25rem;
    border: 1px solid var(--surface-border-strong);
    border-radius: 12px;
    background-color: var(--surface-card);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }

  .total {
    font-size: 1rem;
    color: var(--text-primary);
  }

  .sources {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    font-size: 0.9rem;
  }

  .source-name {
    font-weight: 600;
  }

  .source-count {
    margin-left: 0.25rem;
    color: var(--text-secondary);
  }

  .summary {
    background: var(--code-block-bg);
    color: var(--code-block-text);
    border-radius: 8px;
    padding: 0.75rem;
    white-space: pre-wrap;
    font-family: "Noto Sans JP", system-ui, sans-serif;
    font-size: 0.9rem;
  }

  .no-summary {
    color: var(--placeholder-text);
    font-size: 0.85rem;
  }

  .detail-link {
    align-self: flex-start;
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
    font-size: 0.9rem;
  }

  .detail-link:hover {
    text-decoration: underline;
  }
</style>
