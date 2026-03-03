export type CollectorLogLevel = "debug" | "info" | "warn" | "error";

export type CollectorLogEntry = {
  level: CollectorLogLevel;
  event: string;
  message?: string;
  [key: string]: unknown;
};

export type CollectorLogger = (entry: CollectorLogEntry) => void;

export const noopCollectorLogger: CollectorLogger = () => {};

export function createCollectorLogger(options?: {
  scope?: string;
  now?: () => Date;
  sink?: (line: string) => void;
}): CollectorLogger {
  const scope = options?.scope ?? "collector-slack";
  const now = options?.now ?? (() => new Date());
  const sink = options?.sink ?? ((line: string) => console.log(line));

  return (entry) => {
    const line = {
      ts: now().toISOString(),
      scope,
      ...entry,
    };
    sink(JSON.stringify(line));
  };
}
