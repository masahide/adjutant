import { dirname, join } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import templateSource from "$lib/presentation/templates/clipboardPrompt.hbs?raw";
import { resolveConfigDir } from "$lib/server/config";

const DEFAULT_TEMPLATE_SOURCE = templateSource.trim();
const CUSTOM_TEMPLATE_FILENAME = "clipboardPrompt.hbs";
const CUSTOM_TEMPLATE_DIRNAME = "templates";

export type ClipboardTemplateOrigin = "default" | "custom";

export interface ClipboardTemplatePayload {
  source: string;
  origin: ClipboardTemplateOrigin;
  path: string | null;
}

export function getClipboardTemplatePath(): string {
  return join(resolveConfigDir(), CUSTOM_TEMPLATE_DIRNAME, CUSTOM_TEMPLATE_FILENAME);
}

export async function loadClipboardTemplate(): Promise<ClipboardTemplatePayload> {
  const customPath = getClipboardTemplatePath();
  try {
    const buffer = await readFile(customPath);
    return {
      source: buffer.toString("utf8"),
      origin: "custom",
      path: customPath,
    };
  } catch {
    return {
      source: DEFAULT_TEMPLATE_SOURCE,
      origin: "default",
      path: null,
    };
  }
}

export async function saveClipboardTemplate(source: string): Promise<void> {
  const customPath = getClipboardTemplatePath();
  const dir = dirname(customPath);
  await mkdir(dir, { recursive: true });
  await writeFile(customPath, source, "utf8");
}

export async function deleteClipboardTemplate(): Promise<void> {
  const customPath = getClipboardTemplatePath();
  await rm(customPath, { force: true });
}

export function getDefaultClipboardTemplate(): string {
  return DEFAULT_TEMPLATE_SOURCE;
}
