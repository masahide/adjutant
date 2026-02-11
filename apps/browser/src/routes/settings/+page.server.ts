import { getDefaultClipboardTemplate, loadClipboardTemplate } from "$lib/server/clipboardTemplate";
import { loadSummaryPromptTemplates } from "$lib/server/summaryPrompts";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  const summaryPrompts = await loadSummaryPromptTemplates();
  const active = await loadClipboardTemplate();
  return {
    summaryPrompts: {
      system: summaryPrompts.system,
      user: summaryPrompts.user,
    },
    clipboardTemplate: {
      source: active.source,
      origin: active.origin,
      path: active.path,
      defaultSource: getDefaultClipboardTemplate(),
    },
  };
};
