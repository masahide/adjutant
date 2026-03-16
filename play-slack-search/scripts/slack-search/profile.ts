import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

export function defaultProfilePath(): string {
  return resolve(
    homedir(),
    '.adjutant',
    'tools',
    'play-slack-search',
    'profile',
  );
}

export function normalizeProfilePath(input: string): string {
  const expanded = expandHome(input);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function expandHome(input: string): string {
  if (input === '~') {
    return homedir();
  }
  if (input.startsWith('~/')) {
    return `${homedir()}/${input.slice(2)}`;
  }
  return input;
}
