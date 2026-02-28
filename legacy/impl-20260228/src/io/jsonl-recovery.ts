import { mkdir, readdir, readFile, stat, truncate } from "node:fs/promises";
import { dirname, join } from "node:path";
import { verifyJsonlChecksum } from "./jsonl-checksum.js";

export type JsonlScanResult = {
  filePath: string;
  lineCount: number;
  valid: boolean;
  badOffset: number | null;
  reason?: "partial-tail" | "invalid-json" | "checksum-mismatch";
};

export type JsonlRecoveryResult = JsonlScanResult & {
  repaired: boolean;
  truncatedBytes: number;
};

function lineBufferToString(buffer: Buffer): string {
  const text = buffer.toString("utf8");
  return text.endsWith("\r") ? text.slice(0, -1) : text;
}

function parseLine(line: string): Record<string, unknown> | null {
  if (line.trim().length === 0) {
    return {};
  }
  const parsed = JSON.parse(line) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

export async function scanJsonlFile(filePath: string): Promise<JsonlScanResult> {
  const raw = await readFile(filePath);
  let lineCount = 0;
  let cursor = 0;

  while (cursor < raw.length) {
    const newline = raw.indexOf(0x0a, cursor); // \n
    if (newline === -1) {
      return {
        filePath,
        lineCount,
        valid: false,
        badOffset: cursor,
        reason: "partial-tail",
      };
    }
    const line = lineBufferToString(raw.subarray(cursor, newline));
    try {
      const parsed = parseLine(line);
      if (!parsed) {
        return {
          filePath,
          lineCount,
          valid: false,
          badOffset: cursor,
          reason: "invalid-json",
        };
      }
      if (Object.keys(parsed).length > 0 && !verifyJsonlChecksum(parsed)) {
        return {
          filePath,
          lineCount,
          valid: false,
          badOffset: cursor,
          reason: "checksum-mismatch",
        };
      }
    } catch {
      return {
        filePath,
        lineCount,
        valid: false,
        badOffset: cursor,
        reason: "invalid-json",
      };
    }
    lineCount += 1;
    cursor = newline + 1;
  }

  return {
    filePath,
    lineCount,
    valid: true,
    badOffset: null,
    reason: undefined,
  };
}

export async function recoverJsonlFile(filePath: string): Promise<JsonlRecoveryResult> {
  const scanned = await scanJsonlFile(filePath);
  if (scanned.valid || scanned.badOffset === null) {
    return { ...scanned, repaired: false, truncatedBytes: 0 };
  }
  const fileStat = await stat(filePath);
  await mkdir(dirname(filePath), { recursive: true });
  await truncate(filePath, scanned.badOffset);
  return {
    ...scanned,
    repaired: true,
    truncatedBytes: Math.max(0, fileStat.size - scanned.badOffset),
  };
}

export async function recoverJsonlFiles(
  filePaths: Iterable<string>
): Promise<JsonlRecoveryResult[]> {
  const results: JsonlRecoveryResult[] = [];
  for (const filePath of filePaths) {
    try {
      results.push(await recoverJsonlFile(filePath));
    } catch {
      // 読み込み不可ファイルは起動継続を優先し無視する
    }
  }
  return results;
}

export async function listJsonlFiles(rootDir: string): Promise<string[]> {
  try {
    const root = await stat(rootDir);
    if (!root.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const result: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        result.push(fullPath);
      }
    }
  }
  return result;
}
