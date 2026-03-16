import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PlaySlackSearchListUsersResult } from "./play-slack-search-tool.js";

export type PlaySlackSearchSavedUsersResult = {
  mode: "save-users";
  path: string;
  workspaceHost: string;
  workspaceUrl: string;
  userCount: number;
  sourceUrl?: string;
};

export function resolvePlaySlackSearchWorkspaceHost(workspaceUrl: string): string {
  let url: URL;
  try {
    url = new URL(workspaceUrl);
  } catch {
    throw new Error(`invalid workspaceUrl: ${workspaceUrl}`);
  }
  return url.host.replace(/[^A-Za-z0-9.-]/g, "_");
}

export function resolvePlaySlackSearchWorkspaceToolsDir(
  workspaceDir: string,
  workspaceUrl: string
): string {
  return join(
    workspaceDir,
    "tools",
    "play-slack-search",
    resolvePlaySlackSearchWorkspaceHost(workspaceUrl)
  );
}

export async function savePlaySlackSearchUsersResult(input: {
  workspaceDir: string;
  requestedWorkspaceUrl?: string;
  result: PlaySlackSearchListUsersResult;
  now?: () => string;
}): Promise<PlaySlackSearchSavedUsersResult> {
  const workspaceUrl = resolveWorkspaceUrl(input.requestedWorkspaceUrl, input.result.sourceUrl);
  const workspaceHost = resolvePlaySlackSearchWorkspaceHost(workspaceUrl);
  const targetDir = resolvePlaySlackSearchWorkspaceToolsDir(input.workspaceDir, workspaceUrl);
  const path = join(targetDir, "users.json");
  const generatedAt = input.now?.() ?? new Date().toISOString();

  await mkdir(targetDir, { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        schema: "adjutant.play-slack-search.users.v1",
        generatedAt,
        workspaceUrl,
        workspaceHost,
        userCount: input.result.users.length,
        result: input.result,
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return {
    mode: "save-users",
    path,
    workspaceHost,
    workspaceUrl,
    userCount: input.result.users.length,
    ...(input.result.sourceUrl ? { sourceUrl: input.result.sourceUrl } : {}),
  };
}

function resolveWorkspaceUrl(
  requestedWorkspaceUrl: string | undefined,
  sourceUrl: string | undefined
): string {
  if (requestedWorkspaceUrl) {
    return requestedWorkspaceUrl;
  }
  if (sourceUrl) {
    return sourceUrl;
  }
  throw new Error("workspaceUrl required to save play-slack-search users");
}
