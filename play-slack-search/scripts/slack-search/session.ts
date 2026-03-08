import { type SessionInfo } from './contracts.ts';
import { runPlaywright } from './playwright-cli.ts';
import { normalizeProfilePath } from './profile.ts';

interface PrepareSessionInput {
  profile: string;
  requestedSession: string;
  workspaceUrl: string;
}

export interface PreparedSession {
  openedSession: string | null;
  session: string;
}

interface SessionDependencies {
  closeSession(session: string): void;
  listSessions(): SessionInfo[];
  openSession(input: PrepareSessionInput): void;
}

const defaultSessionDependencies: SessionDependencies = {
  closeSession: safeCloseSession,
  listSessions,
  openSession: openPlaywrightSession,
};

export function prepareSession(
  input: PrepareSessionInput,
  dependencies: SessionDependencies = defaultSessionDependencies,
): PreparedSession {
  const { profile, requestedSession, workspaceUrl } = input;
  const sessionInfos = dependencies.listSessions();
  const requestedSessionInfo =
    sessionInfos.find((info) => info.name === requestedSession) ??
    createUnknownSessionInfo(requestedSession);

  if (
    requestedSessionInfo.status === 'open' &&
    !isSameProfile(requestedSessionInfo.rawUserDataDir, profile)
  ) {
    dependencies.closeSession(requestedSession);
  }

  const reusableSession = sessionInfos.find(
    (info) =>
      info.status === 'open' && isSameProfile(info.rawUserDataDir, profile),
  );

  if (reusableSession) {
    return {
      openedSession: null,
      session: reusableSession.name,
    };
  }

  dependencies.openSession({ profile, requestedSession, workspaceUrl });

  return {
    openedSession: requestedSession,
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
): void {
  const openArgs = buildOpenSessionArgs(input);

  try {
    runPlaywrightCommand(openArgs);
  } catch (error) {
    if (!isBrowserAlreadyInUseError(error)) {
      throw error;
    }

    tryClosePlaywrightSession(input.requestedSession, runPlaywrightCommand);

    try {
      runPlaywrightCommand(openArgs);
      return;
    } catch (retryError) {
      if (!isBrowserAlreadyInUseError(retryError)) {
        throw retryError;
      }
    }

    try {
      runPlaywrightCommand([
        `-s=${input.requestedSession}`,
        'open',
        '--isolated',
        `--profile=${input.profile}`,
        input.workspaceUrl,
      ]);
    } catch (isolatedError) {
      if (!isBrowserAlreadyInUseError(isolatedError)) {
        throw isolatedError;
      }

      throw new Error(
        `Browser profile is already in use: ${input.profile}. Tried session close and isolated open. Run \`playwright-cli -s=${input.requestedSession} close\` or \`playwright-cli kill-all\` and retry.`,
      );
    }
  }
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
