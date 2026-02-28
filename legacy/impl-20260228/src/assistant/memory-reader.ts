import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { auditFileRead, type AgentAuditScope } from "./agent-audit.js";
import { resolveMemoryPaths } from "./memory-paths.js";

export type MemoryReadOptions = {
  workspaceDir: string;
  timezone: string;
  now?: Date;
  auditScope?: AgentAuditScope;
};

export type MemoryReadResult = {
  longTerm: string | null;
  daily: string | null;
  yesterday: string | null;
};

function toAuditPath(workspaceDir: string, filePath: string): string {
  const relPath = relative(resolve(workspaceDir), resolve(filePath)).replaceAll("\\", "/");
  if (!relPath || relPath.startsWith("..")) {
    return resolve(filePath);
  }
  return relPath;
}

async function readOptionalFile(input: {
  filePath: string;
  workspaceDir: string;
  auditScope?: AgentAuditScope;
}): Promise<string | null> {
  const auditPath = toAuditPath(input.workspaceDir, input.filePath);
  try {
    const content = await readFile(input.filePath, "utf8");
    auditFileRead({
      scope: input.auditScope,
      path: auditPath,
      bytes: Buffer.byteLength(content, "utf8"),
      status: "ok",
    });
    return content;
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      auditFileRead({
        scope: input.auditScope,
        path: auditPath,
        bytes: 0,
        status: "ok",
      });
      return null;
    }
    auditFileRead({
      scope: input.auditScope,
      path: auditPath,
      status: "error",
      error: errno.code ?? (error instanceof Error ? error.message : String(error)),
    });
    throw error;
  }
}

export async function readMemoryFiles(opts: MemoryReadOptions): Promise<MemoryReadResult> {
  const paths = resolveMemoryPaths(opts);
  const [longTerm, daily, yesterday] = await Promise.all([
    readOptionalFile({
      filePath: paths.longTermPath,
      workspaceDir: opts.workspaceDir,
      auditScope: opts.auditScope,
    }),
    readOptionalFile({
      filePath: paths.dailyPath,
      workspaceDir: opts.workspaceDir,
      auditScope: opts.auditScope,
    }),
    readOptionalFile({
      filePath: paths.yesterdayPath,
      workspaceDir: opts.workspaceDir,
      auditScope: opts.auditScope,
    }),
  ]);

  return { longTerm, daily, yesterday };
}
