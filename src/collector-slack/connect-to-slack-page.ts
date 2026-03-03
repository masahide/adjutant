export type CdpTarget = {
  id?: string;
  url?: string;
  type?: string;
};

export type SlackPageConnection = {
  close: () => Promise<void>;
};

export type ConnectToSlackPageDeps = {
  listTargets: () => Promise<CdpTarget[]>;
  connect: (target: CdpTarget) => Promise<SlackPageConnection>;
};

export function isSlackPageTarget(target: CdpTarget): boolean {
  if (target.type !== undefined && target.type !== "page") {
    return false;
  }
  const url = target.url ?? "";
  if (!url) {
    return false;
  }
  return (
    url.includes("app.slack.com/client/") ||
    url.includes(".slack.com/client/") ||
    url.includes("slack.com/app_redirect")
  );
}

export function selectSlackPageTarget(targets: readonly CdpTarget[]): CdpTarget | undefined {
  for (const target of targets) {
    if (isSlackPageTarget(target)) {
      return target;
    }
  }
  return undefined;
}

export async function connectToSlackPage(
  deps: ConnectToSlackPageDeps
): Promise<SlackPageConnection> {
  const targets = await deps.listTargets();
  const target = selectSlackPageTarget(targets);
  if (target === undefined) {
    throw new Error("Slack page target not found");
  }
  return deps.connect(target);
}
