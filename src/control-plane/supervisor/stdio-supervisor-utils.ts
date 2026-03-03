type LineReadableStream = {
  setEncoding: (encoding: "utf8") => void;
  on: (event: "data", listener: (chunk: string) => void) => void;
};

export function attachUtf8LineReader(
  stream: LineReadableStream,
  onLine: (line: string) => void
): void {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        onLine(line);
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });
}

export function isUnexpectedChildExit(
  stopping: boolean,
  code: number | null,
  signal: NodeJS.Signals | null
): boolean {
  return !stopping && (code !== 0 || signal !== null);
}

export function computeNextRestartCount(input: {
  crashed: boolean;
  restartCount: number;
  maxRestarts: number;
}): number | null {
  if (!input.crashed) {
    return null;
  }
  if (input.restartCount >= input.maxRestarts) {
    return null;
  }
  return input.restartCount + 1;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
