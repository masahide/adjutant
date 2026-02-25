import CDP from "chrome-remote-interface";
import type { EventEmitter } from "node:events";

const SLACK_APP_RE = /https:\/\/app\.slack\.com/i;

export type SlackCdpClient = CDP.Client & EventEmitter;

type CdpTarget = Awaited<ReturnType<typeof CDP.List>>[number];

export type SlackCdpTargetSummary = {
  targetId: string;
  type?: string;
  title?: string;
  url?: string;
  attached?: boolean;
};

function isSlackAppTarget(target: CdpTarget): boolean {
  return (
    (target.type === "page" || target.type === "webview" || target.type === "other") &&
    SLACK_APP_RE.test(target.url || "")
  );
}

function listSlackTargetsInternal(targets: CdpTarget[]): CdpTarget[] {
  return targets.filter((target) => isSlackAppTarget(target));
}

function toSlackTargetSummary(target: CdpTarget): SlackCdpTargetSummary | null {
  const targetId = typeof target.id === "string" ? target.id : "";
  if (!targetId) {
    return null;
  }
  return {
    targetId,
    type: typeof target.type === "string" ? target.type : undefined,
    title: typeof target.title === "string" ? target.title : undefined,
    url: typeof target.url === "string" ? target.url : undefined,
    attached: (target as { attached?: boolean }).attached === true,
  };
}

export async function listSlackAppTargets(
  host: string,
  port: number
): Promise<SlackCdpTargetSummary[]> {
  const targets = await CDP.List({ host, port });
  return listSlackTargetsInternal(targets)
    .map(toSlackTargetSummary)
    .filter((item): item is SlackCdpTargetSummary => item !== null);
}

export async function connectToSlackPage(
  host: string,
  port: number
): Promise<{ client: SlackCdpClient; slackUrl: string; targetId: string }> {
  const targets = await CDP.List({ host, port });
  const page = listSlackTargetsInternal(targets)[0];
  if (!page) throw new Error("Slack page target not found. Open app.slack.com in the desktop app.");
  const client = (await CDP({ host, port, target: page })) as SlackCdpClient;
  return { client, slackUrl: page.url || "", targetId: page.id || "" };
}

export async function connectToSlackTarget(
  host: string,
  port: number,
  targetId: string
): Promise<{ client: SlackCdpClient; slackUrl: string; targetId: string }> {
  const normalizedTargetId = targetId.trim();
  if (!normalizedTargetId) {
    throw new Error("target_id is required");
  }
  const targets = await CDP.List({ host, port });
  const target = listSlackTargetsInternal(targets).find((item) => item.id === normalizedTargetId);
  if (!target) {
    throw new Error(`Slack target not found: ${normalizedTargetId}`);
  }
  const client = (await CDP({ host, port, target })) as SlackCdpClient;
  return {
    client,
    slackUrl: target.url || "",
    targetId: target.id || normalizedTargetId,
  };
}
