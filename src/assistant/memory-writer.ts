import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { auditFileWrite, type AgentAuditScope } from "./agent-audit.js";
import { resolveMemoryPaths } from "./memory-paths.js";

export type MemoryWriteOptions = {
  workspaceDir: string;
  timezone: string;
  now?: Date;
  auditScope?: AgentAuditScope;
};

function toAuditPath(workspaceDir: string, filePath: string): string {
  const relPath = relative(resolve(workspaceDir), resolve(filePath)).replaceAll("\\", "/");
  if (!relPath || relPath.startsWith("..")) {
    return resolve(filePath);
  }
  return relPath;
}

async function hasExistingContent(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.size > 0;
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function appendDailyMemory(content: string, opts: MemoryWriteOptions): Promise<void> {
  const text = content.trim();
  if (!text) {
    return;
  }

  const paths = resolveMemoryPaths(opts);
  const prefix = (await hasExistingContent(paths.dailyPath)) ? "\n" : "";
  const line = `${prefix}${text}\n`;
  const bytes = Buffer.byteLength(line, "utf8");
  const auditPath = toAuditPath(opts.workspaceDir, paths.dailyPath);
  try {
    await mkdir(paths.dailyDir, { recursive: true });
    await appendFile(paths.dailyPath, line, "utf8");
    auditFileWrite({
      scope: opts.auditScope,
      path: auditPath,
      bytes,
      status: "ok",
    });
  } catch (error) {
    auditFileWrite({
      scope: opts.auditScope,
      path: auditPath,
      bytes,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function updateLongTermMemory(
  content: string,
  opts: MemoryWriteOptions
): Promise<void> {
  const paths = resolveMemoryPaths(opts);
  const bytes = Buffer.byteLength(content, "utf8");
  const auditPath = toAuditPath(opts.workspaceDir, paths.longTermPath);
  try {
    await mkdir(opts.workspaceDir, { recursive: true });
    await writeFile(paths.longTermPath, content, "utf8");
    auditFileWrite({
      scope: opts.auditScope,
      path: auditPath,
      bytes,
      status: "ok",
    });
  } catch (error) {
    auditFileWrite({
      scope: opts.auditScope,
      path: auditPath,
      bytes,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
