import { spawnSync } from 'node:child_process';

export function runPlaywright(args: string[]): string {
  const result = spawnSync('playwright-cli', args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const combined = [stdout.trimEnd(), stderr.trimEnd()]
    .filter(Boolean)
    .join('\n');

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      combined || `playwright-cli exited with code ${result.status}`,
    );
  }

  return combined;
}

export function runPlaywrightInteractive(args: string[]): void {
  const result = spawnSync('playwright-cli', args, {
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`playwright-cli exited with code ${result.status}`);
  }
}

export function runJson<T>(args: string[]): T {
  const output = runPlaywright(args);
  return parseRunCodeJsonOutput<T>(output);
}

export function parseRunCodeJsonOutput<T>(output: string): T {
  const match = output.match(/### Result\r?\n([\s\S]*?)(?:\r?\n### |\s*$)/);

  if (match) {
    return JSON.parse(match[1]) as T;
  }

  const errorMatch = output.match(/### Error\r?\n([\s\S]*?)\s*$/);
  if (errorMatch) {
    throw new Error(errorMatch[1].trim());
  }

  throw new Error(
    `Could not find JSON result in playwright-cli output.\n${output}`,
  );
}

export function serializeBrowserCode<TInput>(
  browserRunner: (page: unknown, input: TInput) => Promise<unknown> | unknown,
  input: TInput,
): string {
  return `async page => { const __name = (target, _name) => target; return (${browserRunner.toString()})(page, ${JSON.stringify(input)}); }`;
}
