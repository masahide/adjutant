import { Marked } from "marked";
import type { Tokens } from "marked";

export type SlackRichTextElement =
  | { type: "text"; text: string; style?: Record<string, boolean>; url?: string }
  | { type: "link"; url: string; text?: string }
  | { type: "emoji"; name: string }
  | { type: "user"; user_id: string }
  | { type: string; [key: string]: unknown };

export type SlackRichTextBlock =
  | { type: "rich_text_section"; elements: SlackRichTextElement[] }
  | { type: string; [key: string]: unknown };

export type SlackRichText = { type: "rich_text"; elements: SlackRichTextBlock[] };

export type MarkdownFlavor = "message" | "summary";

const sanitizer = {
  walkTokens(token: Tokens.Generic) {
    if (token.type === "link" || token.type === "image") {
      const linkToken = token as Tokens.Link | Tokens.Image;
      const href = linkToken.href ?? "";
      if (isUnsafeUrl(href)) {
        linkToken.href = "";
      }
    }
  },
};

const messageRenderer = new Marked();
messageRenderer.setOptions({
  gfm: true,
  breaks: true,
});

messageRenderer.use(sanitizer);

export function renderMessageMarkdown(source: string): string {
  if (!source) {
    return "";
  }
  const normalized = normalizeSlackFormatting(source);
  const output = messageRenderer.parse(normalized);
  return typeof output === "string" ? output : normalized;
}

const summaryRenderer = new Marked();
summaryRenderer.setOptions({
  gfm: true,
  breaks: true,
});

summaryRenderer.use(sanitizer);

export function renderSummaryMarkdown(source: string): string {
  if (!source) {
    return "";
  }
  const output = summaryRenderer.parse(source);
  return typeof output === "string" ? output : source;
}

function isUnsafeUrl(href: string): boolean {
  const lower = href.trim().toLowerCase();
  return lower.startsWith("javascript:") || lower.startsWith("data:");
}

function normalizeSlackFormatting(value: string): string {
  return value.replace(/(^|[\s>])\*(?!\*)([^*\n]+?)\*(?!\*)/g, (_match, prefix, content) => {
    return `${prefix}**${content.trim()}**`;
  });
}

export function renderBlocksMarkdown(blocks: unknown[]): string {
  const normalized = normalizeBlocks(blocks);
  if (!normalized) {
    return "";
  }
  const lines: string[] = [];
  for (const block of normalized) {
    if (block.type !== "rich_text") {
      continue;
    }
    for (const section of block.elements) {
      const line = renderSection(section);
      if (line) {
        lines.push(line);
      }
    }
  }
  return lines.join("\n");
}

function normalizeBlocks(blocks: unknown[]): SlackRichText[] | null {
  if (!Array.isArray(blocks)) {
    return null;
  }
  const normalized: SlackRichText[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const type = (block as { type?: string }).type;
    if (type === "rich_text" && Array.isArray((block as SlackRichText).elements)) {
      normalized.push(block as SlackRichText);
    }
  }
  return normalized.length > 0 ? normalized : null;
}

function renderSection(section: SlackRichTextBlock): string {
  if (!section || typeof section !== "object") {
    return "";
  }
  if (section.type !== "rich_text_section" || !Array.isArray(section.elements)) {
    return "";
  }
  const parts = section.elements.map(renderElement).filter(Boolean);
  return parts.join("");
}

function renderElement(element: SlackRichTextElement): string {
  if (!element || typeof element !== "object") {
    return "";
  }
  switch (element.type) {
    case "text": {
      const text = typeof element.text === "string" ? element.text : "";
      const style = element.style as Record<string, boolean> | undefined;
      return applyTextStyle(text, style);
    }
    case "link":
      if (element.url) {
        const label = element.text ?? element.url;
        return `[${label}](${element.url})`;
      }
      return "";
    case "emoji":
      return element.name ? `:${element.name}:` : "";
    case "user":
      return element.user_id ? `@${element.user_id}` : "";
    default:
      return "";
  }
}

function applyTextStyle(text: string, style?: Record<string, boolean>): string {
  let result = text;
  const applied = style ?? {};
  if (applied.code) {
    result = "`" + result + "`";
  }
  if (applied.bold) {
    result = "**" + result + "**";
  }
  if (applied.italic) {
    result = "_" + result + "_";
  }
  if (applied.strike) {
    result = "~~" + result + "~~";
  }
  if (applied.underline) {
    result = "__" + result + "__";
  }
  return result;
}
