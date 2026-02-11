<script lang="ts">
  import { createEventDispatcher, onDestroy, tick } from "svelte";
  import { createMarkdownPipeline } from "$lib/preview/markdownPipeline";

  export let markdown: string | null = null;
  export let debounce = 300;

  const pipeline = createMarkdownPipeline({ debounce });
  let rendered: string | null = null;
  let container: HTMLDivElement | null = null;
  const dispatch = createEventDispatcher<{ ready: { element: HTMLDivElement | null } }>();
  let lastEmitted: HTMLDivElement | null = null;

  const notifyReady = async () => {
    await tick();
    const next = rendered ? container : null;
    if (next !== lastEmitted) {
      lastEmitted = next;
      dispatch("ready", { element: next });
    }
  };

  const unsubscribe = pipeline.subscribe((value) => {
    rendered = value;
    void notifyReady();
  });

  $: pipeline.update(markdown ?? null);

  onDestroy(() => {
    unsubscribe();
    pipeline.destroy();
  });

  export function getScrollableElement(): HTMLDivElement | null {
    return container;
  }
</script>

{#if rendered}
  <div class="markdown" data-testid="markdown-preview" bind:this={container}>
    {@html rendered}
  </div>
{:else}
  <p class="placeholder">サマリがまだありません。</p>
{/if}

<style>
  .markdown :global(code) {
    background: var(--inline-code-bg);
    color: var(--inline-code-text);
    padding: 0.15rem 0.3rem;
    border-radius: 4px;
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  }

  .markdown :global(pre) {
    background: var(--code-block-bg);
    color: var(--code-block-text);
    padding: 0.75rem;
    border-radius: 8px;
    overflow-x: auto;
  }

  .markdown :global(h1),
  .markdown :global(h2),
  .markdown :global(h3) {
    margin-top: 1.2rem;
    margin-bottom: 0.6rem;
  }

  .placeholder {
    color: var(--placeholder-text);
    font-size: 0.9rem;
  }
</style>
