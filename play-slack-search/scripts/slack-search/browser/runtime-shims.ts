type BrowserPage = any;

export const NAME_HELPER_SHIM_SOURCE =
  'var __name = globalThis.__name || ((target, _name) => target); globalThis.__name = __name;';

function normalizeRuntimeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function installBrowserRuntimeShims(
  page: BrowserPage,
): Promise<void> {
  if (typeof page.addInitScript === 'function') {
    await page.addInitScript({ content: NAME_HELPER_SHIM_SOURCE });
  }
  if (typeof page.evaluate === 'function') {
    await page.evaluate(NAME_HELPER_SHIM_SOURCE).catch(() => null);
  }
}

export function buildSlackClientStateUnavailableError(input: {
  action: "slack.list-users" | "slack.list-channels" | "slack.resolve-channel-id";
  workspaceUrl: string;
  cause: unknown;
}): Error {
  const causeMessage = normalizeRuntimeErrorMessage(input.cause);

  return new Error(
    `${input.action} could not read Slack client state from IndexedDB (reduxPersistence/reduxPersistenceStore). ` +
      `Open ${input.workspaceUrl} with slack/search mode=login, complete Slack login, then retry. ` +
      `Pass workspaceUrl explicitly if the target workspace is ambiguous. ` +
      `Cause: ${causeMessage}`,
  );
}
