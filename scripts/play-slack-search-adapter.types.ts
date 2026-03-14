export type ExecuteSlackCommandExport = {
  executeSlackCommand: (
    options: {
      hydrate: boolean;
      limit: number;
      listChannels: boolean;
      listUsers: boolean;
      query: string;
      resolveChannelIds: string[];
      workspaceUrl: string;
    },
    session: string
  ) => unknown;
};

export type LoadPackageEnvExport = {
  loadPackageEnv: () => void;
  PLAY_SLACK_SEARCH_WORKSPACE_URL_ENV: string;
};

export type NormalizeProfilePathExport = {
  normalizeProfilePath: (value: string) => string;
  defaultProfilePath: () => string;
};

export type PlaywrightCliExport = {
  runJson: <T>(args: string[]) => T;
  serializeBrowserCode: <TInput>(
    browserRunner: (page: unknown, input: TInput) => Promise<unknown> | unknown,
    input: TInput
  ) => string;
};

export type PrepareSessionExport = {
  prepareSession: (input: { profile: string; requestedSession: string; workspaceUrl: string }) => {
    openedSession: string | null;
    session: string;
  };
};

export type SafeCloseSessionExport = {
  safeCloseSession: (session: string) => void;
};

export type DefaultSessionExport = {
  DEFAULT_SESSION: string;
};
