import {
  cpSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  type Stats,
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { type SessionInfo } from './contracts.ts';
import { runPlaywright } from './playwright-cli.ts';
import { normalizeProfilePath } from './profile.ts';

interface PrepareSessionInput {
  profile: string;
  requestedSession: string;
  workspaceUrl: string;
}

export interface PreparedSession {
  debug: {
    sessionMessages: string[];
  };
  openedSession: string | null;
  profile: string;
  session: string;
}

interface SessionDependencies {
  closeSession(session: string): void;
  listSessions(): SessionInfo[];
  openSession(
    input: PrepareSessionInput,
    log: (message: string) => void,
  ): string;
  log(message: string): void;
}

const defaultSessionDependencies: SessionDependencies = {
  closeSession: safeCloseSession,
  listSessions,
  log: logSessionMessage,
  openSession: (input, log) => openPlaywrightSession(input, runPlaywright, cloneProfileForReadOnlyUse, log),
};

export function prepareSession(
  input: PrepareSessionInput,
  dependencies: SessionDependencies = defaultSessionDependencies,
): PreparedSession {
  const startedAt = Date.now();
  const sessionMessages: string[] = [];
  const log = (message: string) => {
    sessionMessages.push(message);
    dependencies.log(message);
  };
  const { profile, requestedSession, workspaceUrl } = input;
  const listedAt = Date.now();
  const sessionInfos = dependencies.listSessions();
  log(
    `session.list elapsed=${formatElapsedMs(Date.now() - listedAt)} count=${sessionInfos.length}`,
  );
  const requestedSessionInfo =
    sessionInfos.find((info) => info.name === requestedSession) ??
    createUnknownSessionInfo(requestedSession);

  if (
    requestedSessionInfo.status === 'open' &&
    !isSameProfile(requestedSessionInfo.rawUserDataDir, profile)
  ) {
    log(
      `session.close requested=${requestedSession} reason=profile-mismatch profile=${requestedSessionInfo.rawUserDataDir ?? 'unknown'}`,
    );
    dependencies.closeSession(requestedSession);
  }

  const reusableSession = sessionInfos.find(
    (info) =>
      info.status === 'open' && isSameProfile(info.rawUserDataDir, profile),
  );

  if (reusableSession) {
    log(
      `session.ready reused=${reusableSession.name} elapsed=${formatElapsedMs(Date.now() - startedAt)}`,
    );
    return {
      debug: {
        sessionMessages,
      },
      openedSession: null,
      profile,
      session: reusableSession.name,
    };
  }

  const openedAt = Date.now();
  const openedProfile = dependencies.openSession(
    {
      profile,
      requestedSession,
      workspaceUrl,
    },
    log,
  );
  log(
    `session.ready opened=${requestedSession} profile=${openedProfile} elapsed=${formatElapsedMs(Date.now() - startedAt)} open_elapsed=${formatElapsedMs(Date.now() - openedAt)}`,
  );

  return {
    debug: {
      sessionMessages,
    },
    openedSession: requestedSession,
    profile: openedProfile,
    session: requestedSession,
  };
}

export function safeCloseSession(session: string): void {
  try {
    runPlaywright([`-s=${session}`, 'close']);
  } catch {
    // Best-effort cleanup only.
  }
}

export function openPlaywrightSession(
  input: PrepareSessionInput,
  runPlaywrightCommand: typeof runPlaywright = runPlaywright,
  cloneProfile: (profile: string) => string = cloneProfileForReadOnlyUse,
  log: (message: string) => void = logSessionMessage,
): string {
  const startedAt = Date.now();
  const openArgs = buildOpenSessionArgs(input);

  try {
    const directStartedAt = Date.now();
    runPlaywrightCommand(openArgs);
    log(
      `session.open path=direct elapsed=${formatElapsedMs(Date.now() - directStartedAt)}`,
    );
    return input.profile;
  } catch (error) {
    if (!isBrowserAlreadyInUseError(error)) {
      throw error;
    }
    log('session.open path=direct result=profile-in-use');

    const closeStartedAt = Date.now();
    tryClosePlaywrightSession(input.requestedSession, runPlaywrightCommand);
    log(
      `session.close requested=${input.requestedSession} reason=profile-in-use elapsed=${formatElapsedMs(Date.now() - closeStartedAt)}`,
    );

    try {
      const retryStartedAt = Date.now();
      runPlaywrightCommand(openArgs);
      log(
        `session.open path=retry-after-close elapsed=${formatElapsedMs(Date.now() - retryStartedAt)} total=${formatElapsedMs(Date.now() - startedAt)}`,
      );
      return input.profile;
    } catch (retryError) {
      if (!isBrowserAlreadyInUseError(retryError)) {
        throw retryError;
      }
      log('session.open path=retry-after-close result=profile-in-use');
    }

    try {
      const isolatedStartedAt = Date.now();
      runPlaywrightCommand([
        `-s=${input.requestedSession}`,
        'open',
        '--isolated',
        `--profile=${input.profile}`,
        input.workspaceUrl,
      ]);
      log(
        `session.open path=isolated elapsed=${formatElapsedMs(Date.now() - isolatedStartedAt)} total=${formatElapsedMs(Date.now() - startedAt)}`,
      );
      return input.profile;
    } catch (isolatedError) {
      if (
        !isBrowserAlreadyInUseError(isolatedError) &&
        !isUnsupportedIsolatedOptionError(isolatedError)
      ) {
        throw isolatedError;
      }
      log(
        `session.open path=isolated result=${isUnsupportedIsolatedOptionError(isolatedError) ? 'unsupported' : 'profile-in-use'}`,
      );

      const closeStartedAt = Date.now();
      tryClosePlaywrightSession(input.requestedSession, runPlaywrightCommand);
      log(
        `session.close requested=${input.requestedSession} reason=before-clone-fallback elapsed=${formatElapsedMs(Date.now() - closeStartedAt)}`,
      );
      const cloneStartedAt = Date.now();
      const clonedProfile = cloneProfile(input.profile);
      log(
        `session.clone profile=${clonedProfile} elapsed=${formatElapsedMs(Date.now() - cloneStartedAt)}`,
      );

      try {
        const clonedOpenStartedAt = Date.now();
        runPlaywrightCommand([
          `-s=${input.requestedSession}`,
          'open',
          `--profile=${clonedProfile}`,
          input.workspaceUrl,
        ]);
        log(
          `session.open path=cloned-profile elapsed=${formatElapsedMs(Date.now() - clonedOpenStartedAt)} total=${formatElapsedMs(Date.now() - startedAt)}`,
        );
        return clonedProfile;
      } catch (clonedError) {
        safeRemoveProfileClone(clonedProfile, input.profile);
        if (!isBrowserAlreadyInUseError(clonedError)) {
          throw clonedError;
        }

        throw new Error(
          `Browser profile is already in use: ${input.profile}. Tried session close, isolated open, and cloned profile fallback. Run \`playwright-cli -s=${input.requestedSession} close\` or \`playwright-cli kill-all\` and retry.`,
        );
      }
    }
  }
}

function logSessionMessage(message: string): void {
  process.stderr.write(`[slack-search] ${message}\n`);
}

function formatElapsedMs(elapsedMs: number): string {
  return `${(elapsedMs / 1000).toFixed(1)}s`;
}

function listSessions(): SessionInfo[] {
  const output = runPlaywright(['list']);
  return parseSessionListOutput(output);
}

export function parseSessionListOutput(output: string): SessionInfo[] {
  const lines = output.split(/\r?\n/);
  const sessions: SessionInfo[] = [];
  let current: SessionInfo | null = null;

  for (const line of lines) {
    const sessionHeaderMatch = line.match(/^- ([^:]+):$/);
    if (sessionHeaderMatch) {
      if (current) {
        sessions.push(current);
      }
      current = createUnknownSessionInfo(sessionHeaderMatch[1]);
      continue;
    }

    if (!current) {
      continue;
    }

    const statusMatch = line.match(/status:\s+(open|closed)/);
    if (statusMatch) {
      current.status = statusMatch[1] === 'open' ? 'open' : 'closed';
    }

    const userDataDirMatch = line.match(/user-data-dir:\s+(.+)/);
    if (userDataDirMatch) {
      current.rawUserDataDir = userDataDirMatch[1].trim();
    }
  }

  if (current) {
    sessions.push(current);
  }

  return sessions;
}

function createUnknownSessionInfo(name: string): SessionInfo {
  return {
    name,
    rawUserDataDir: null,
    status: 'unknown',
  };
}

function isSameProfile(
  rawUserDataDir: string | null,
  expectedProfile: string,
): boolean {
  if (!rawUserDataDir || rawUserDataDir.includes('~')) {
    return false;
  }

  return normalizeProfilePath(rawUserDataDir) === expectedProfile;
}

function buildOpenSessionArgs(input: PrepareSessionInput): string[] {
  return [
    `-s=${input.requestedSession}`,
    'open',
    `--profile=${input.profile}`,
    input.workspaceUrl,
  ];
}

function isBrowserAlreadyInUseError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('Browser is already in use')
  );
}

function isUnsupportedIsolatedOptionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("unknown '--isolated' option")
  );
}

function tryClosePlaywrightSession(
  session: string,
  runPlaywrightCommand: typeof runPlaywright,
): void {
  try {
    runPlaywrightCommand([`-s=${session}`, 'close']);
  } catch {
    // Best-effort cleanup only.
  }
}

function cloneProfileForReadOnlyUse(sourceProfile: string): string {
  if (!existsSync(sourceProfile)) {
    throw new Error(`Profile directory does not exist: ${sourceProfile}`);
  }
  if (!statSync(sourceProfile).isDirectory()) {
    throw new Error(`Profile path is not a directory: ${sourceProfile}`);
  }

  const cloneRoot = mkdtempSync(join(tmpdir(), 'play-slack-search-profile-'));
  const clonePath = join(cloneRoot, basename(sourceProfile));

  try {
    cpSync(sourceProfile, clonePath, {
      recursive: true,
      filter: (src) => {
        const name = basename(src);
        return ![
          'SingletonCookie',
          'SingletonLock',
          'SingletonSocket',
          'DevToolsActivePort',
          'lockfile',
        ].includes(name);
      },
    });
    return clonePath;
  } catch (error) {
    rmSync(cloneRoot, { force: true, recursive: true });
    throw error;
  }
}

function safeRemoveProfileClone(
  profilePath: string,
  sourceProfile: string,
): void {
  if (
    normalizeProfilePath(profilePath) === normalizeProfilePath(sourceProfile)
  ) {
    return;
  }

  let stats: Stats | null = null;
  try {
    stats = statSync(profilePath);
  } catch {
    return;
  }

  if (!stats.isDirectory()) {
    return;
  }

  try {
    rmSync(profilePath, { force: true, recursive: true });
    rmSync(join(profilePath, '..'), { force: true, recursive: true });
  } catch {
    // Best-effort cleanup only.
  }
}
