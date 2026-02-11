import { error, json } from "@sveltejs/kit";

import {
  loadSummaryPromptTemplates,
  resetSummaryPromptTemplates,
  saveSummaryPromptTemplates,
} from "$lib/server/summaryPrompts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  const templates = await loadSummaryPromptTemplates();
  return json({
    system: templates.system,
    user: templates.user,
  });
};

export const PUT: RequestHandler = async ({ request }) => {
  const payload = (await request.json()) as {
    systemPrompt?: unknown;
    userPrompt?: unknown;
  };

  if (typeof payload.systemPrompt !== "string" || typeof payload.userPrompt !== "string") {
    throw error(400, "systemPrompt と userPrompt は文字列で指定してください。");
  }

  await saveSummaryPromptTemplates({
    systemPrompt: payload.systemPrompt,
    userPrompt: payload.userPrompt,
  });

  const templates = await loadSummaryPromptTemplates();
  return json({
    system: templates.system,
    user: templates.user,
  });
};

export const DELETE: RequestHandler = async () => {
  await resetSummaryPromptTemplates();
  const templates = await loadSummaryPromptTemplates();
  return json({
    system: templates.system,
    user: templates.user,
  });
};
