<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { browser } from "$app/environment";
  import { themeController } from "$lib/client/theme";

  onMount(() => {
    if (!browser) {
      return;
    }
    themeController.connect();
  });

  onDestroy(() => {
    themeController.disconnect();
  });
</script>

<slot />

<style>
  :global(:root) {
    color-scheme: light;
    --surface-body: #f3f4f6;
    --surface-card: #ffffff;
    --surface-border-strong: rgba(15, 23, 42, 0.12);
    --text-primary: #1f2937;
    --text-secondary: #4b5563;
    --accent: #2563eb;
    --accent-strong: #1d4ed8;
    --tag-bg: #e0f2fe;
    --tag-text: #0f172a;
    --inline-code-bg: #f1f5f9;
    --inline-code-text: #0f172a;
    --code-block-bg: #0f172a;
    --code-block-text: #f8fafc;
    --toast-bg: rgba(17, 24, 39, 0.92);
    --toast-text: #f9fafb;
    --button-muted-bg: rgba(148, 163, 184, 0.2);
    --button-muted-text: #1f2937;
    --placeholder-text: #6b7280;
  }

  :global([data-theme="dark"]) {
    color-scheme: dark;
    --surface-body: #0f172a;
    --surface-card: rgba(17, 24, 39, 0.92);
    --surface-border-strong: rgba(148, 176, 208, 0.28);
    --text-primary: #e2e8f0;
    --text-secondary: #94a3b8;
    --accent: #60a5fa;
    --accent-strong: #3b82f6;
    --tag-bg: rgba(59, 130, 246, 0.2);
    --tag-text: #bfdbfe;
    --inline-code-bg: rgba(148, 163, 184, 0.18);
    --inline-code-text: #e2e8f0;
    --code-block-bg: #0b1120;
    --code-block-text: #e2e8f0;
    --toast-bg: rgba(30, 41, 59, 0.92);
    --toast-text: #f8fafc;
    --button-muted-bg: rgba(255, 255, 255, 0.14);
    --button-muted-text: #e2e8f0;
    --placeholder-text: #94a3b8;
  }

  :global(body) {
    margin: 0;
    min-height: 100vh;
    background: var(--surface-body);
    color: var(--text-primary);
    font-family:
      "Inter",
      "Noto Sans JP",
      system-ui,
      -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      sans-serif;
    transition:
      background 0.3s ease,
      color 0.3s ease;
  }

  :global(a) {
    color: var(--accent);
  }

  :global(button),
  :global(select) {
    font-family: inherit;
  }
</style>
