import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveAdjutantStateDir } from "./session-paths.js";

type RunIndexRecord = {
  runId: string;
  sessionKey: string;
  ts: string;
};

const RUN_INDEX_DEFAULT_RELATIVE_PATH = join("index", "run-index.ndjson");

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function takeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseRunIndexRecord(rawLine: string, lineNo: number): RunIndexRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    console.warn("[RunIndexRepository] invalid run-index line skipped", {
      reason: "json-parse-failed",
      lineNo,
    });
    return null;
  }

  const record = asRecord(parsed);
  if (!record) {
    console.warn("[RunIndexRepository] invalid run-index line skipped", {
      reason: "not-object",
      lineNo,
    });
    return null;
  }

  const runId = takeString(record.runId);
  const sessionKey = takeString(record.sessionKey);
  const ts = takeString(record.ts);
  if (!runId || !sessionKey || !ts) {
    console.warn("[RunIndexRepository] invalid run-index line skipped", {
      reason: "missing-required-fields",
      lineNo,
    });
    return null;
  }
  return { runId, sessionKey, ts };
}

export function resolveRunIndexPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ADJUTANT_RUN_INDEX_PATH?.trim();
  if (configured) {
    return resolve(configured);
  }
  return join(resolveAdjutantStateDir({ env }), RUN_INDEX_DEFAULT_RELATIVE_PATH);
}

export async function appendRunIndex(
  runId: string,
  sessionKey: string,
  ts: string,
  opts?: { path?: string }
): Promise<void> {
  const normalizedRunId = runId.trim();
  const normalizedSessionKey = sessionKey.trim();
  const normalizedTs = ts.trim();
  if (!normalizedRunId || !normalizedSessionKey || !normalizedTs) {
    return;
  }

  const path = resolve(opts?.path ?? resolveRunIndexPath());
  await mkdir(dirname(path), { recursive: true });
  await appendFile(
    path,
    `${JSON.stringify({
      runId: normalizedRunId,
      sessionKey: normalizedSessionKey,
      ts: normalizedTs,
    } satisfies RunIndexRecord)}\n`,
    "utf8"
  );
}

export async function resolveSessionKeyByRunId(
  runId: string,
  opts?: { path?: string }
): Promise<string | null> {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return null;
  }

  const path = resolve(opts?.path ?? resolveRunIndexPath());
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const lines = raw.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line?.trim()) {
      continue;
    }
    const parsed = parseRunIndexRecord(line, index + 1);
    if (!parsed) {
      continue;
    }
    if (parsed.runId === normalizedRunId) {
      return parsed.sessionKey;
    }
  }
  return null;
}
