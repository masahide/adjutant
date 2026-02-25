import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { formatWithOptions } from "node:util";

const CAPTURE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

type CapturedMethod = (typeof CAPTURE_METHODS)[number];
type ConsoleFn = (...args: unknown[]) => void;

export type ConsoleFileLoggerHandle = {
  path: string;
  flush: () => Promise<void>;
  restore: () => Promise<void>;
};

export async function installConsoleFileLogger(path: string): Promise<ConsoleFileLoggerHandle> {
  const resolvedPath = resolve(path);
  await mkdir(dirname(resolvedPath), { recursive: true });

  const original = new Map<CapturedMethod, ConsoleFn>();
  for (const method of CAPTURE_METHODS) {
    const fn = console[method] as unknown as ConsoleFn;
    original.set(method, fn.bind(console));
  }

  let appendTail = Promise.resolve();

  const appendLine = (level: CapturedMethod, args: unknown[]): void => {
    const formatted = formatWithOptions({ colors: false, depth: null }, ...args);
    const line = `${new Date().toISOString()} [${level}] ${formatted}\n`;
    appendTail = appendTail
      .then(async () => {
        await appendFile(resolvedPath, line, "utf8");
      })
      .catch((error) => {
        const originalError = original.get("error");
        const reason = error instanceof Error ? error.message : String(error);
        originalError?.(`[Assistant][LogFile] append failed: ${reason}`);
      });
  };

  for (const method of CAPTURE_METHODS) {
    const originalFn = original.get(method);
    if (!originalFn) {
      continue;
    }
    const wrapped: ConsoleFn = (...args: unknown[]) => {
      originalFn(...args);
      appendLine(method, args);
    };
    console[method] = wrapped as (typeof console)[typeof method];
  }

  return {
    path: resolvedPath,
    flush: async () => {
      await appendTail;
    },
    restore: async () => {
      for (const method of CAPTURE_METHODS) {
        const originalFn = original.get(method);
        if (!originalFn) {
          continue;
        }
        console[method] = originalFn as (typeof console)[typeof method];
      }
      await appendTail;
    },
  };
}
