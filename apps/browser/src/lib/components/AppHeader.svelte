<script lang="ts">
  export let variant: "default" | "compact" = "default";
</script>

<header class={`app-header ${variant}`}>
  <div class="app-header-main">
    <slot name="main" />
  </div>
  <div class="app-header-actions">
    <slot name="actions" />
  </div>
</header>

<style>
  .app-header {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  @media (min-width: 768px) {
    .app-header {
      flex-direction: row;
      justify-content: space-between;
      align-items: flex-start;
    }
  }

  .app-header-main {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
  }

  .app-header-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  .compact {
    gap: 1rem;
  }
</style>
