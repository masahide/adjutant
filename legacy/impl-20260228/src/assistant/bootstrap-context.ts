import { DEFAULT_BOOTSTRAP_FILENAME, type WorkspaceBootstrapFile } from "./workspace-bootstrap.js";

export type EmbeddedContextFile = {
  path: string;
  content: string;
};

export type BootstrapContextOptions = {
  maxCharsPerFile?: number;
  headRatio?: number;
  tailRatio?: number;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
};

const DEFAULT_MAX_CHARS_PER_FILE = 20_000;
const DEFAULT_HEAD_RATIO = 0.7;
const DEFAULT_TAIL_RATIO = 0.2;

function resolveMaxChars(value: number | undefined): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
    return DEFAULT_MAX_CHARS_PER_FILE;
  }
  return Math.floor(value as number);
}

function resolveRatio(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0 || (value ?? 0) >= 1) {
    return fallback;
  }
  return value as number;
}

function trimBootstrapContent(params: {
  content: string;
  fileName: string;
  maxChars: number;
  headRatio: number;
  tailRatio: number;
}): { content: string; truncated: boolean; originalLength: number } {
  const normalized = params.content.trimEnd();
  if (normalized.length <= params.maxChars) {
    return {
      content: normalized,
      truncated: false,
      originalLength: normalized.length,
    };
  }

  const headChars = Math.max(1, Math.floor(params.maxChars * params.headRatio));
  const tailChars = Math.max(1, Math.floor(params.maxChars * params.tailRatio));
  const head = normalized.slice(0, headChars);
  const tail = normalized.slice(-tailChars);
  const marker = [
    "",
    `[...truncated, read ${params.fileName} for full content...]`,
    `...(truncated ${params.fileName}: kept ${headChars}+${tailChars} chars of ${normalized.length})...`,
    "",
  ].join("\n");

  return {
    content: `${head}\n${marker}\n${tail}`,
    truncated: true,
    originalLength: normalized.length,
  };
}

export function buildBootstrapContextFiles(
  files: WorkspaceBootstrapFile[],
  options: BootstrapContextOptions = {}
): EmbeddedContextFile[] {
  const maxChars = resolveMaxChars(options.maxCharsPerFile);
  const headRatio = resolveRatio(options.headRatio, DEFAULT_HEAD_RATIO);
  const tailRatio = resolveRatio(options.tailRatio, DEFAULT_TAIL_RATIO);
  const contextFiles: EmbeddedContextFile[] = [];

  for (const file of files) {
    if (file.missing) {
      if (file.name === DEFAULT_BOOTSTRAP_FILENAME) {
        continue;
      }
      contextFiles.push({
        path: file.name,
        content: `[MISSING] Expected at: ${file.path}`,
      });
      continue;
    }

    const trimmed = trimBootstrapContent({
      content: file.content ?? "",
      fileName: file.name,
      maxChars,
      headRatio,
      tailRatio,
    });

    if (!trimmed.content) {
      continue;
    }

    if (trimmed.truncated) {
      options.onWarn?.("bootstrap_context_truncated", {
        fileName: file.name,
        originalLength: trimmed.originalLength,
        maxChars,
      });
    }

    contextFiles.push({
      path: file.name,
      content: trimmed.content,
    });
  }

  return contextFiles;
}

export function renderProjectContext(contextFiles: EmbeddedContextFile[]): string {
  if (contextFiles.length === 0) {
    return "";
  }

  const lines: string[] = [
    "# Project Context",
    "",
    "The following project context files have been loaded:",
  ];
  for (const file of contextFiles) {
    lines.push("", `## ${file.path}`, file.content);
  }
  return lines.join("\n");
}
