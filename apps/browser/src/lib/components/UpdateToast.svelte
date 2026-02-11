<script lang="ts">
  import { createEventDispatcher } from "svelte";

  export let visible = false;
  export let message = "更新があります";

  const dispatch = createEventDispatcher<{ refresh: void; dismiss: void }>();

  const handleRefresh = () => {
    dispatch("refresh");
  };

  const handleDismiss = () => {
    dispatch("dismiss");
  };
</script>

{#if visible}
  <div class="update-toast" role="status" aria-live="polite">
    <span class="message">{message}</span>
    <div class="actions">
      <button type="button" class="primary" on:click={handleRefresh}>反映する</button>
      <button type="button" on:click={handleDismiss}>閉じる</button>
    </div>
  </div>
{/if}

<style>
  .update-toast {
    position: fixed;
    inset-inline-end: 2rem;
    inset-block-end: 2rem;
    max-width: 320px;
    background: var(--toast-bg);
    color: var(--toast-text);
    padding: 1rem 1.25rem;
    border-radius: 12px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    z-index: 1000;
  }

  .message {
    font-size: 0.95rem;
    line-height: 1.4;
  }

  .actions {
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
  }

  button {
    border: none;
    border-radius: 999px;
    padding: 0.4rem 0.95rem;
    font-size: 0.85rem;
    cursor: pointer;
    background: rgba(249, 250, 251, 0.12);
    color: inherit;
    transition:
      background 0.2s ease,
      transform 0.2s ease;
  }

  button:hover {
    background: rgba(249, 250, 251, 0.2);
    transform: translateY(-1px);
  }

  button.primary {
    background: var(--accent);
    color: #fff;
  }

  button.primary:hover {
    background: var(--accent-strong);
  }
</style>
