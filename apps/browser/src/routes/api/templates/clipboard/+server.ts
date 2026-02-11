import { json, error } from "@sveltejs/kit";
import {
  deleteClipboardTemplate,
  getDefaultClipboardTemplate,
  loadClipboardTemplate,
  saveClipboardTemplate,
} from "$lib/server/clipboardTemplate";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  const active = await loadClipboardTemplate();
  return json({
    source: active.source,
    origin: active.origin,
    path: active.path,
    defaultSource: getDefaultClipboardTemplate(),
  });
};

export const PUT: RequestHandler = async ({ request }) => {
  const payload = (await request.json()) as { source?: unknown };
  if (typeof payload?.source !== "string") {
    throw error(400, "source must be a string");
  }
  await saveClipboardTemplate(payload.source);
  const active = await loadClipboardTemplate();
  return json({
    source: active.source,
    origin: active.origin,
    path: active.path,
  });
};

export const DELETE: RequestHandler = async () => {
  await deleteClipboardTemplate();
  const active = await loadClipboardTemplate();
  return json({
    source: active.source,
    origin: active.origin,
    path: active.path,
  });
};
