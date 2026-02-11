import { join } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import Handlebars from "handlebars";

import { resolveConfigDir } from "$lib/server/config";

export type SummaryPromptKind = "system" | "user";

type TemplateOrigin = "default" | "custom";

export interface SummaryPromptTemplateState {
  source: string;
  defaultSource: string;
  origin: TemplateOrigin;
  path: string | null;
}

export interface SummaryPromptTemplates {
  system: SummaryPromptTemplateState;
  user: SummaryPromptTemplateState;
}

export interface SaveSummaryPromptPayload {
  systemPrompt: string;
  userPrompt: string;
}

const TEMPLATE_DIRNAME = "templates";
const SYSTEM_PROMPT_FILENAME = "summarySystemPrompt.txt";
const USER_PROMPT_FILENAME = "summaryUserPrompt.hbs";

export const DEFAULT_SYSTEM_PROMPT = [
  "あなたは日報の Markdown サマリを共同編集するアシスタントです。",
  "- 役割: 編集者として、ユーザーの入力を尊重しつつサマリ文書の品質を高めること",
  "- トーン: 丁寧で簡潔（必要十分な説明に留める）",
  "- 目的: summary_update と assistant_message を JSON Schema に従って必ず生成すること",
  "- 良い応答例: summary_update.mode を適切に選び、content には Markdown の差分本文のみを含める。assistant_message では提案理由と次のアクションを短く示す",
  "- 悪い応答例: schema にないフィールドを追加する、content に差分以外の説明を混在させる、assistant_message を空にする",
].join("\n");

export const DEFAULT_USER_PROMPT = [
  "# Summary Request",
  "{{#if date}}対象日: {{date}}{{/if}}",
  "",
  "{{#if prompt}}## ユーザー指示",
  "{{prompt}}",
  "{{/if}}",
  "",
  "{{#if selection}}## 選択中のサマリ",
  "開始: {{selection.start}} / 終了: {{selection.end}}",
  "---",
  "{{selection.content}}",
  "{{/if}}",
  "",
  "{{#if content}}## 現在のサマリ",
  "{{content}}",
  "{{/if}}",
  "",
  "{{#if hasEvents}}## タイムラインイベント",
  "{{#each events}}- {{time}} {{source}}{{#if channel}} {{channel}}{{/if}} :: {{message}}{{#if reaction}} ({{reaction}}){{/if}}",
  "{{/each}}",
  "{{/if}}",
].join("\n");

export async function loadSummaryPromptTemplates(): Promise<SummaryPromptTemplates> {
  const system = await readTemplate(SYSTEM_PROMPT_FILENAME, DEFAULT_SYSTEM_PROMPT);
  const user = await readTemplate(USER_PROMPT_FILENAME, DEFAULT_USER_PROMPT);
  return { system, user };
}

export async function saveSummaryPromptTemplates(payload: SaveSummaryPromptPayload): Promise<void> {
  const baseDir = getTemplateDir();
  await mkdir(baseDir, { recursive: true });
  await Promise.all([
    writeFile(join(baseDir, SYSTEM_PROMPT_FILENAME), payload.systemPrompt, "utf-8"),
    writeFile(join(baseDir, USER_PROMPT_FILENAME), payload.userPrompt, "utf-8"),
  ]);
}

export async function resetSummaryPromptTemplates(): Promise<void> {
  const baseDir = getTemplateDir();
  await Promise.all([
    rm(join(baseDir, SYSTEM_PROMPT_FILENAME), { force: true }),
    rm(join(baseDir, USER_PROMPT_FILENAME), { force: true }),
  ]);
}

type SummaryPromptSelection = {
  start: number;
  end: number;
  content: string;
} | null;

export type SummaryPromptEventContext = {
  uid: string;
  source: string;
  channel: string | null;
  message: string;
  reaction: string | null;
  time: string;
  timestamp: string | null;
};

export interface SummaryPromptContext {
  mode: "chat" | "initial" | (string & {});
  date?: string | null;
  prompt?: string | null;
  content?: string | null;
  selection?: SummaryPromptSelection;
  events?: SummaryPromptEventContext[];
  hasEvents?: boolean;
}

const rendererCache = new Map<string, Handlebars.TemplateDelegate<SummaryPromptContext>>();

export function renderSummaryUserPrompt(
  templateSource: string,
  context: SummaryPromptContext
): string {
  const renderer = getRenderer(templateSource);
  const normalized = normalizeContext(context);
  return renderer(normalized).trim();
}

function normalizeContext(context: SummaryPromptContext): SummaryPromptContext {
  const selection =
    context.selection && context.selection.content.trim().length > 0 ? context.selection : null;
  const events = Array.isArray(context.events) ? context.events.filter(Boolean) : [];
  return {
    ...context,
    prompt: context.prompt ?? null,
    content: context.content ?? null,
    selection,
    events,
    hasEvents: context.hasEvents ?? events.length > 0,
  };
}

function getRenderer(source: string): Handlebars.TemplateDelegate<SummaryPromptContext> {
  const key = source.trim();
  const cached = rendererCache.get(key);
  if (cached) {
    return cached;
  }
  const instance = Handlebars.create();
  const renderer = instance.compile<SummaryPromptContext>(source);
  rendererCache.set(key, renderer);
  return renderer;
}

async function readTemplate(
  filename: string,
  defaultSource: string
): Promise<SummaryPromptTemplateState> {
  const baseDir = getTemplateDir();
  const filePath = join(baseDir, filename);
  try {
    const buffer = await readFile(filePath, "utf-8");
    return {
      source: buffer,
      defaultSource,
      origin: "custom",
      path: filePath,
    };
  } catch {
    return {
      source: defaultSource,
      defaultSource,
      origin: "default",
      path: null,
    };
  }
}

function getTemplateDir(): string {
  const configDir = resolveConfigDir();
  return join(configDir, TEMPLATE_DIRNAME);
}
