<script lang="ts">
  import DaySummaryCard from "$lib/components/DaySummaryCard.svelte";
  import { formatIsoTimestamp } from "$lib/format/date";
  import AppHeader from "$lib/components/AppHeader.svelte";
  import ThemeSwitcher from "$lib/components/ThemeSwitcher.svelte";
  import type { PageData } from "./$types";

  export let data: PageData;

  const formatTimestamp = formatIsoTimestamp;
</script>

<svelte:head>
  <title>ReacLog ダッシュボード</title>
</svelte:head>

<main class="container">
  <AppHeader>
    <svelte:fragment slot="main">
      <h1>ReacLog ブラウザビュー</h1>
      <p class="generated-at">最終更新: {formatTimestamp(data.generatedAt)}</p>
    </svelte:fragment>
    <svelte:fragment slot="actions">
      <a class="settings-link" href="/settings">テンプレート編集</a>
      <ThemeSwitcher selectId="dashboard-theme" />
    </svelte:fragment>
  </AppHeader>

  <section class="cards">
    <h2>最近の活動ログ</h2>
    {#if data.days.length === 0}
      <p class="empty">表示できるログがまだありません。</p>
    {:else}
      <div class="grid">
        {#each data.days as day}
          <DaySummaryCard {day} />
        {/each}
      </div>
    {/if}
  </section>
</main>

<style>
  .container {
    display: flex;
    flex-direction: column;
    gap: 2rem;
    padding: 2rem;
    max-width: 960px;
    margin: 0 auto;
  }

  .settings-link {
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
  }

  .generated-at {
    margin-top: 0.5rem;
    font-size: 0.875rem;
    color: var(--text-secondary);
  }

  .cards h2 {
    margin-bottom: 1rem;
  }

  .grid {
    display: grid;
    gap: 1rem;
  }

  @media (min-width: 720px) {
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .empty {
    color: var(--placeholder-text);
  }
</style>
