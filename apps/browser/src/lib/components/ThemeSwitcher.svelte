<script lang="ts">
  import { themeController, type ThemeMode } from "$lib/client/theme";

  export let selectId = "theme-select";
  export let label = "テーマ";
  export let showLabel = true;

  const themeMode = themeController.mode;

  const themeOptions: Array<{ value: ThemeMode; label: string }> = [
    { value: "light", label: "ライト" },
    { value: "dark", label: "ダーク" },
    { value: "system", label: "システム" },
  ];

  const handleThemeChange = (event: Event) => {
    const value = (event.currentTarget as HTMLSelectElement).value as ThemeMode;
    themeController.setTheme(value);
  };

  const toggleTheme = () => {
    themeController.toggle();
  };
</script>

<div class="theme-switcher">
  {#if showLabel}
    <label class="theme-label" for={selectId}>{label}</label>
  {/if}
  <div class="theme-controls">
    <select id={selectId} bind:value={$themeMode} on:change={handleThemeChange}>
      {#each themeOptions as option}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
    <button type="button" class="theme-toggle" on:click={toggleTheme}>切替</button>
  </div>
</div>

<style>
  .theme-switcher {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .theme-label {
    font-size: 0.85rem;
    color: var(--text-secondary);
  }

  .theme-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  select {
    border-radius: 999px;
    border: 1px solid var(--surface-border-strong);
    background: var(--surface-card);
    color: var(--text-primary);
    padding: 0.35rem 0.9rem;
    font-size: 0.85rem;
    appearance: none;
  }

  select:focus {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .theme-toggle {
    border: none;
    background: var(--button-muted-bg);
    color: var(--button-muted-text);
    border-radius: 999px;
    padding: 0.35rem 0.8rem;
    font-size: 0.85rem;
    cursor: pointer;
    transition:
      background 0.2s ease,
      transform 0.2s ease;
  }

  .theme-toggle:hover {
    background: var(--accent);
    color: #fff;
    transform: translateY(-1px);
  }
</style>
