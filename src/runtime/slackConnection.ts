import CDP from "chrome-remote-interface";
import type { EventEmitter } from "node:events";

const SLACK_APP_RE = /https:\/\/app\.slack\.com/i;

export type SlackCdpClient = CDP.Client & EventEmitter;

export async function connectToSlackPage(
  host: string,
  port: number
): Promise<{ client: SlackCdpClient; slackUrl: string }> {
  const targets = await CDP.List({ host, port });
  const page = targets.find(
    (t) =>
      (t.type === "page" || t.type === "webview" || t.type === "other") &&
      SLACK_APP_RE.test(t.url || "")
  );
  if (!page) throw new Error("Slack page target not found. Open app.slack.com in the desktop app.");
  const client = (await CDP({ host, port, target: page })) as SlackCdpClient;
  return { client, slackUrl: page.url! };
}
