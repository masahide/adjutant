type RichTextText = { type: "text"; text: string };
type RichTextSection = { type: "rich_text_section"; elements?: RichTextNode[] };
type RichTextNode = RichTextText | RichTextSection | { type: string; [k: string]: unknown };
type Block = { elements?: RichTextNode[] };

/** Slack blocksからplain textを抽出 */
export function fromBlocks(blocks: unknown): string {
  const arr: unknown = Array.isArray(blocks)
    ? blocks
    : typeof blocks === "string"
      ? (() => {
          try {
            return JSON.parse(blocks);
          } catch {
            return [];
          }
        })()
      : [];

  if (!Array.isArray(arr)) return "";

  const texts: string[] = [];
  const visit = (node: RichTextNode): void => {
    if (!node || typeof node !== "object") return;
    if ((node as RichTextText).type === "text" && typeof (node as RichTextText).text === "string") {
      texts.push((node as RichTextText).text);
      return;
    }
    if ((node as RichTextSection).type === "rich_text_section") {
      const children = (node as RichTextSection).elements;
      if (Array.isArray(children)) children.forEach(visit);
      return;
    }
  };

  for (const b of arr as Block[]) {
    if (b && typeof b === "object" && Array.isArray(b.elements)) {
      for (const n of b.elements) visit(n);
    }
  }
  return texts.join("");
}
