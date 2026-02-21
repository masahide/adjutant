import { createHash } from "node:crypto";
import type { MemoryChunk } from "./types.js";

function hashText(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function chunkMarkdownByChars(params: {
  content: string;
  chunkChars: number;
  chunkOverlapChars: number;
}): MemoryChunk[] {
  const lines = params.content.split("\n");
  if (lines.length === 0) {
    return [];
  }

  const maxChars = Math.max(256, params.chunkChars);
  const overlapChars = Math.max(0, params.chunkOverlapChars);
  const chunks: MemoryChunk[] = [];

  let current: Array<{ lineNo: number; text: string }> = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    const first = current[0];
    const last = current[current.length - 1];
    if (!first || !last) {
      return;
    }
    const text = current
      .map((entry) => entry.text)
      .join("\n")
      .trim();
    if (!text) {
      return;
    }
    chunks.push({
      startLine: first.lineNo,
      endLine: last.lineNo,
      text,
      hash: hashText(text),
    });
  };

  const carryOverlap = () => {
    if (overlapChars <= 0 || current.length === 0) {
      current = [];
      currentChars = 0;
      return;
    }
    const kept: Array<{ lineNo: number; text: string }> = [];
    let chars = 0;
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const line = current[i];
      if (!line) {
        continue;
      }
      chars += line.text.length + 1;
      kept.unshift(line);
      if (chars >= overlapChars) {
        break;
      }
    }
    current = kept;
    currentChars = current.reduce((sum, line) => sum + line.text.length + 1, 0);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index] ?? "";
    const lineNo = index + 1;
    current.push({ lineNo, text: lineText });
    currentChars += lineText.length + 1;
    if (currentChars < maxChars) {
      continue;
    }
    flush();
    carryOverlap();
  }

  flush();
  return chunks;
}
